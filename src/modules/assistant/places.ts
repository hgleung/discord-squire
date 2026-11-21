import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * The owner's Google Maps saved lists (Food, Bars, Dessert, Cafes...).
 *
 * Google has no API for saved lists, so each list is read from its share
 * link through the same undocumented call the list's own web page makes
 * (maps/preview/entitylist/getlist). It needs no sign-in for a list shared
 * by link, and it can break whenever Google changes that page: a failed sync
 * keeps the last good copy and records the error.
 *
 * Hours, ratings and price come from the Places API (New), looked up once per
 * place and refreshed monthly, so "open now" is answered from cached data.
 * Nothing is ever written back to Google Maps.
 */

const SHORTLINK_UA = 'Mozilla/5.0'; // a full browser UA gets a JS interstitial instead of a redirect
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PLACES_API = 'https://places.googleapis.com/v1/places:searchText';
/** Hours, rating and price are Enterprise fields: 1,000 free lookups a month. */
const DETAIL_FIELDS = [
  'id',
  'displayName',
  'formattedAddress',
  'location',
  'timeZone',
  'regularOpeningHours',
  'rating',
  'priceLevel',
  'businessStatus',
  'primaryTypeDisplayName',
  'websiteUri',
  'googleMapsUri',
];
/** Just where a place is: a Pro lookup, 5,000 free a month. */
const LOCATION_FIELDS = ['displayName', 'formattedAddress', 'location'];
const DETAILS_MAX_AGE_MS = 30 * 86_400_000;

export interface LatLng {
  lat: number;
  lng: number;
}

interface TimePoint {
  day: number; // 0 = Sunday
  hour: number;
  minute: number;
}

export interface PlaceDetails {
  placeId: string;
  timeZone?: string;
  periods?: { open: TimePoint; close?: TimePoint }[];
  /** Google's own "Monday: 11:00 AM – 10:00 PM" lines, Monday first. */
  weekdayHours?: string[];
  rating?: number;
  priceLevel?: string;
  status?: string;
  type?: string;
  website?: string;
  fetchedAt: string;
}

export interface SavedPlace {
  /** The Maps CID for list entries; a generated id for places added by chat. */
  key: string;
  list: string;
  name: string;
  address?: string;
  location?: LatLng;
  note?: string;
  mapsUrl?: string;
  /** list: synced from a Google Maps list. chat: added through the assistant, Squire's copy only. */
  source: 'list' | 'chat';
  details?: PlaceDetails;
  /** Set when the Places API couldn't match it, so it isn't retried every sync. */
  unmatchedAt?: string;
}

export interface SavedList {
  url: string;
  name: string;
  syncedAt?: string;
  error?: string;
}

interface PlacesFile {
  lists: SavedList[];
  places: SavedPlace[];
  /** Geocoded free text (the home location, trip destinations), so each is looked up once. */
  geocodes: Record<string, (LatLng & { label: string }) | null>;
  /** Calendar events a trip digest was already posted for. */
  tripsNotified: string[];
}

export class PlaceStore {
  data: PlacesFile = { lists: [], places: [], geocodes: {}, tripsNotified: [] };

  constructor(private readonly path: string) {
    if (existsSync(path)) this.data = { ...this.data, ...(JSON.parse(readFileSync(path, 'utf8')) as Partial<PlacesFile>) };
  }

  get file(): string {
    return this.path;
  }

  save() {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.path);
  }
}

// --- reading a shared list ---

export interface ListedPlace {
  name: string;
  address?: string;
  location?: LatLng;
  note?: string;
  cid?: string;
}

/** Follows a share link by hand so the cookies set along the way go with the list request. */
async function resolveList(url: string): Promise<{ listId: string; token?: string; cookies: string }> {
  const cookies: string[] = [];
  let current = url;
  for (let hop = 0; hop < 8; hop++) {
    const res = await fetch(current, { redirect: 'manual', headers: { 'User-Agent': SHORTLINK_UA, Cookie: cookies.join('; ') } });
    for (const c of res.headers.getSetCookie()) cookies.push(c.split(';')[0]!);
    const next = res.headers.get('location');
    if (!next || res.status < 300 || res.status >= 400) break;
    current = new URL(next, current).toString();
  }
  const listId = /!2s(-?[\w-]+)!/.exec(current)?.[1] ?? /\/placelists\/list\/(-?[\w-]+)/.exec(current)?.[1];
  if (!listId) throw new Error(`That link doesn't open a Google Maps list (it went to ${current.slice(0, 120)}). Share the list itself, not a place.`);
  const token = /token%3D([\w-]+)/.exec(current)?.[1] ?? /[?&]token=([\w-]+)/.exec(current)?.[1];
  return { listId, token, cookies: cookies.join('; ') };
}

/** The getlist response: a nested array behind an anti-JSON-hijacking prefix. */
export function parseListResponse(text: string): { title: string; places: ListedPlace[] } {
  const data = JSON.parse(text.replace(/^\)\]\}'\s*/, '')) as unknown[][];
  const root = data[0] as unknown[];
  const title = typeof root[4] === 'string' ? root[4] : 'Saved places';
  const entries = (Array.isArray(root[8]) ? root[8] : []) as unknown[][];
  const places: ListedPlace[] = [];
  for (const p of entries) {
    const info = (Array.isArray(p[1]) ? p[1] : []) as unknown[];
    const name = typeof p[2] === 'string' ? p[2] : typeof info[2] === 'string' ? info[2] : undefined;
    if (!name) continue;
    const coords = Array.isArray(info[5]) ? (info[5] as unknown[]) : [];
    const cid = Array.isArray(info[6]) && typeof info[6][1] === 'string' ? (info[6] as string[]) : undefined;
    places.push({
      name,
      address: typeof info[4] === 'string' ? info[4] : undefined,
      location: typeof coords[2] === 'number' && typeof coords[3] === 'number' ? { lat: coords[2], lng: coords[3] } : undefined,
      // The owner's own note on the entry, when there is one.
      note: typeof p[3] === 'string' && p[3].trim() ? p[3].trim() : undefined,
      cid: cid ? `${cid[0]}:${cid[1]}` : undefined,
    });
  }
  return { title, places };
}

export async function fetchSharedList(url: string): Promise<{ title: string; places: ListedPlace[] }> {
  const { listId, token, cookies } = await resolveList(url);
  const page = `https://www.google.com/maps/placelists/list/${listId}${token ? `?token=${token}` : ''}`;
  // The !1s value is a per-session id the real page makes up; any random one works.
  const pb = `!2e2!3e2!4i500!6m3!1s${randomUUID().replace(/-/g, '')}!15i204459!28e2!13s${encodeURIComponent(page)}!16b1`;
  const res = await fetch(`https://www.google.com/maps/preview/entitylist/getlist?authuser=0&hl=en&gl=us&pb=${pb}`, {
    headers: { 'User-Agent': BROWSER_UA, Cookie: cookies },
  });
  if (!res.ok) throw new Error(`Google answered ${res.status} for the list. Check it's shared by link and opens in a private window without signing in.`);
  try {
    return parseListResponse(await res.text());
  } catch {
    throw new Error("Google's list page came back in a shape Squire doesn't recognise; Google may have changed it.");
  }
}

/**
 * A stable maps.google.com link from the CID pair. The list endpoint gives
 * signed 64-bit decimals ("-9182…:-3089…"); older data used hex ("0x…:0x…").
 * The link wants the second half as an unsigned decimal.
 */
export function mapsLink(cid: string | undefined, name: string, address?: string): string {
  const second = cid?.split(':')[1];
  if (second && /^(-?\d+|0x[\da-f]+)$/i.test(second)) return `https://maps.google.com/?cid=${BigInt.asUintN(64, BigInt(second)).toString()}`;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([name, address].filter(Boolean).join(' '))}`;
}

// --- geometry and hours ---

/** How far from the area asked for an added place's match can be before it's taken for a namesake elsewhere. */
export const MAX_ADD_KM = 20;

export const KM_PER_MILE = 1.609344;

export function distanceKm(a: LatLng, b: LatLng): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Day of week (0 = Sunday) and minute of day on the place's own clock. */
function localTime(at: Date, timeZone: string): { day: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return { day: WEEKDAYS.indexOf(get('weekday')), minute: Number(get('hour')) * 60 + Number(get('minute')) };
}

/** Whether the place is open at that moment: undefined when its hours or time zone are unknown. */
export function isOpenAt(details: PlaceDetails | undefined, at: Date): boolean | undefined {
  if (!details?.periods?.length || !details.timeZone) return undefined;
  const { day, minute } = localTime(at, details.timeZone);
  const week = 7 * 1440;
  const t = day * 1440 + minute;
  for (const { open, close } of details.periods) {
    const start = open.day * 1440 + open.hour * 60 + open.minute;
    // No close: open around the clock.
    if (!close) return true;
    let end = close.day * 1440 + close.hour * 60 + close.minute;
    if (end <= start) end += week; // runs past Saturday night into Sunday
    if ((t >= start && t < end) || (t + week >= start && t + week < end)) return true;
  }
  return false;
}

/** Today's line of Google's opening hours, e.g. "Thursday: 11:00 AM – 10:00 PM". */
export function todaysHours(details: PlaceDetails | undefined, at: Date): string | undefined {
  if (!details?.weekdayHours?.length || !details.timeZone) return undefined;
  const { day } = localTime(at, details.timeZone);
  return details.weekdayHours[(day + 6) % 7]; // Google's list starts on Monday
}

// --- Places API (New) ---

interface ApiPlace {
  id: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  location?: { latitude: number; longitude: number };
  timeZone?: { id?: string };
  regularOpeningHours?: { periods?: { open: TimePoint; close?: TimePoint }[]; weekdayDescriptions?: string[] };
  rating?: number;
  priceLevel?: string;
  businessStatus?: string;
  primaryTypeDisplayName?: { text?: string };
  websiteUri?: string;
  googleMapsUri?: string;
}

export class PlacesApi {
  constructor(private readonly key: string) {}

  private async search(query: string, fields: string[], near?: LatLng, radius = 2000): Promise<ApiPlace[]> {
    const res = await fetch(PLACES_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': this.key,
        'X-Goog-FieldMask': fields.map((f) => `places.${f}`).join(','),
      },
      body: JSON.stringify({
        textQuery: query,
        pageSize: 3,
        ...(near ? { locationBias: { circle: { center: { latitude: near.lat, longitude: near.lng }, radius } } } : {}),
      }),
    });
    const body = (await res.json().catch(() => ({}))) as { places?: ApiPlace[]; error?: { message?: string } };
    if (!res.ok) throw new Error(`Places API error ${res.status}: ${body.error?.message ?? 'no details'}`);
    return body.places ?? [];
  }

  /** Where a free-text place or area is ("Union Square SF", "Chicago"); undefined when Google finds nothing. */
  async locate(query: string, near?: LatLng): Promise<(LatLng & { label: string }) | undefined> {
    const [hit] = await this.search(query, LOCATION_FIELDS, near, 50_000);
    if (!hit?.location) return undefined;
    return { lat: hit.location.latitude, lng: hit.location.longitude, label: hit.formattedAddress ?? hit.displayName?.text ?? query };
  }

  /**
   * Full details for a named place, biased to where it should be. With `exact`,
   * `near` is the place's own coordinates (a synced list entry), so only a match
   * right there counts; otherwise `near` is just the area to search around.
   */
  async find(query: string, near?: LatLng, exact = false): Promise<FoundPlace | undefined> {
    const hits = await this.search(query, DETAIL_FIELDS, near, near && exact ? 300 : 50_000);
    // A saved spot's coordinates are exact: anything far from them is a different branch or business.
    const hit = hits.find((h) => !exact || !near || !h.location || distanceKm(near, { lat: h.location.latitude, lng: h.location.longitude }) < 0.5);
    return hit ? found(hit, query) : undefined;
  }

  /** Google's top matches for a place, with details, for looking one up without saving it. */
  async lookup(query: string, near?: LatLng): Promise<FoundPlace[]> {
    return (await this.search(query, DETAIL_FIELDS, near, 50_000)).map((h) => found(h, query));
  }
}

export interface FoundPlace {
  name: string;
  address?: string;
  location?: LatLng;
  mapsUrl?: string;
  details: PlaceDetails;
}

function found(hit: ApiPlace, query: string): FoundPlace {
  return {
    name: hit.displayName?.text ?? query,
    address: hit.formattedAddress,
    location: hit.location ? { lat: hit.location.latitude, lng: hit.location.longitude } : undefined,
    mapsUrl: hit.googleMapsUri,
    details: {
      placeId: hit.id,
      timeZone: hit.timeZone?.id,
      periods: hit.regularOpeningHours?.periods,
      weekdayHours: hit.regularOpeningHours?.weekdayDescriptions,
      rating: hit.rating,
      priceLevel: hit.priceLevel,
      status: hit.businessStatus,
      type: hit.primaryTypeDisplayName?.text,
      website: hit.websiteUri,
      fetchedAt: new Date().toISOString(),
    },
  };
}

// --- keeping the lists current ---

export interface SavedPlacesOptions {
  file: string;
  /** Share links of the owner's lists. */
  listUrls: string[];
  /** Places API key; without it there are no hours, no "near <somewhere>", and no adding by chat. */
  apiKey?: string;
  /** The owner's home, as free text (ASSISTANT_LOCATION). */
  home?: string;
}

/** Most Places lookups one sync may make, so a big new list can't run up a bill in one go. */
const LOOKUPS_PER_SYNC = 150;

/** "Corner Cafe" and "Corner Cafe - Salem" are the same spot. */
function sameName(a: string, b: string): boolean {
  const x = a.toLowerCase().trim();
  const y = b.toLowerCase().trim();
  return x.includes(y) || y.includes(x);
}

export class SavedPlaces {
  readonly store: PlaceStore;
  readonly api?: PlacesApi;
  private syncing?: Promise<void>;

  constructor(private readonly opts: SavedPlacesOptions) {
    this.store = new PlaceStore(opts.file);
    this.api = opts.apiKey ? new PlacesApi(opts.apiKey) : undefined;
  }

  lists(): SavedList[] {
    return this.store.data.lists;
  }

  places(): SavedPlace[] {
    return this.store.data.places;
  }

  /** Re-reads every list, then looks up hours for anything new or stale. One run at a time. */
  sync(): Promise<void> {
    this.syncing ??= this.runSync().finally(() => (this.syncing = undefined));
    return this.syncing;
  }

  private async runSync() {
    for (const url of this.opts.listUrls) {
      const meta = this.store.data.lists.find((l) => l.url === url) ?? { url, name: url };
      if (!this.store.data.lists.includes(meta)) this.store.data.lists.push(meta);
      try {
        const { title, places } = await fetchSharedList(url);
        this.merge(meta, title, places);
        meta.syncedAt = new Date().toISOString();
        delete meta.error;
      } catch (err) {
        // Keep the last good copy; the error shows in places_lists.
        meta.error = err instanceof Error ? err.message : String(err);
        console.error(`[places] could not read ${url}: ${meta.error}`);
      }
      this.store.save();
    }
    // Lists removed from .env go, along with what was synced from them.
    const urls = new Set(this.opts.listUrls);
    const dropped = new Set(this.store.data.lists.filter((l) => !urls.has(l.url)).map((l) => l.name));
    this.store.data.lists = this.store.data.lists.filter((l) => urls.has(l.url));
    this.store.data.places = this.store.data.places.filter((p) => p.source === 'chat' || !dropped.has(p.list));
    this.store.save();
    await this.enrich();
  }

  private merge(meta: SavedList, title: string, listed: ListedPlace[]) {
    const all = this.store.data.places;
    if (meta.name !== title) {
      // Renamed in Google Maps: chat-added places follow it.
      for (const p of all) if (p.list === meta.name) p.list = title;
      meta.name = title;
    }
    const before = new Map(all.filter((p) => p.list === title && p.source === 'list').map((p) => [p.key, p]));
    const fresh: SavedPlace[] = listed.map((l) => {
      const key = l.cid ?? `${l.name}|${l.address ?? ''}`;
      const old = before.get(key);
      return {
        key,
        list: title,
        name: l.name,
        address: l.address,
        location: l.location,
        note: l.note,
        mapsUrl: mapsLink(l.cid, l.name, l.address),
        source: 'list',
        details: old?.details,
        unmatchedAt: old?.unmatchedAt,
      };
    });
    // A spot added by chat and since saved in Google Maps too: keep only the Google one.
    const duplicate = (p: SavedPlace) =>
      fresh.some((f) => f.name.toLowerCase() === p.name.toLowerCase() && (!f.location || !p.location || distanceKm(f.location, p.location) < 0.2));
    this.store.data.places = [...all.filter((p) => p.list !== title || (p.source === 'chat' && !duplicate(p))), ...fresh];
  }

  private async enrich() {
    if (!this.api) return;
    const now = Date.now();
    const due = this.store.data.places.filter(
      (p) =>
        (!p.details || now - Date.parse(p.details.fetchedAt) > DETAILS_MAX_AGE_MS) &&
        (!p.unmatchedAt || now - Date.parse(p.unmatchedAt) > DETAILS_MAX_AGE_MS),
    );
    // Round-robin across lists, so a 400-place list can't starve a 20-place one
    // when the daily quota runs out partway.
    const byList = new Map<string, SavedPlace[]>();
    for (const p of due) byList.set(p.list, [...(byList.get(p.list) ?? []), p]);
    const queues = [...byList.values()];
    const order: SavedPlace[] = [];
    for (let i = 0; order.length < due.length; i++) for (const q of queues) if (q[i]) order.push(q[i]!);
    for (const p of order.slice(0, LOOKUPS_PER_SYNC)) {
      try {
        const hit = await this.api.find([p.name, p.address].filter(Boolean).join(', '), p.location, true);
        if (hit) {
          p.details = hit.details;
          delete p.unmatchedAt;
        } else {
          p.unmatchedAt = new Date().toISOString();
        }
      } catch (err) {
        // Billing off, key wrong, quota: stop here and try again next sync.
        console.error(`[places] hours lookup stopped: ${err instanceof Error ? err.message : String(err)}`);
        break;
      }
    }
    this.store.save();
  }

  /** Where some free text is, looked up once and remembered. */
  async locate(query: string): Promise<(LatLng & { label: string }) | undefined> {
    const key = query.trim().toLowerCase();
    if (key in this.store.data.geocodes) return this.store.data.geocodes[key] ?? undefined;
    if (!this.api) throw new Error('Placing an area on the map needs GOOGLE_MAPS_API_KEY; filter by name or list instead.');
    const hit = (await this.api.locate(query, await this.home())) ?? null;
    this.store.data.geocodes[key] = hit;
    this.store.save();
    return hit ?? undefined;
  }

  /** The owner's home (ASSISTANT_LOCATION), when it's set and can be placed. */
  async home(): Promise<LatLng | undefined> {
    const home = this.opts.home?.trim();
    if (!home) return undefined;
    const key = home.toLowerCase();
    if (!(key in this.store.data.geocodes)) {
      if (!this.api) return undefined;
      this.store.data.geocodes[key] = (await this.api.locate(home)) ?? null;
      this.store.save();
    }
    return this.store.data.geocodes[key] ?? undefined;
  }

  /** Adds a place to a list in Squire's copy, looked up on Google so it has hours and a location. */
  async add(list: string, query: string, near: LatLng | undefined, note?: string): Promise<SavedPlace> {
    if (!this.api) throw new Error('Adding a place needs GOOGLE_MAPS_API_KEY so Squire can look it up.');
    const hit = await this.api.find(query, near ?? (await this.home()));
    if (!hit) throw new Error(`Google found nothing for "${query}". Add the city or street.`);
    // The search is only biased to the area, so a name Google doesn't know can
    // land on a namesake in another city. Don't save that pin.
    const off = near && hit.location ? distanceKm(near, hit.location) : 0;
    if (off > MAX_ADD_KM) {
      throw new Error(
        `Not saved: Google's best match for "${query}" is ${hit.name}, ${hit.address ?? 'no address'}, ${Math.round(off / KM_PER_MILE)} miles from the area searched, so it's probably a different place. ` +
          'Search again with the street address from the post as the query, or a fuller name. If that really is the place, search again with near set to its own area.',
      );
    }
    // A synced entry may not have been looked up yet (no placeId), so also match
    // the same name at the same spot.
    const same = (p: SavedPlace) =>
      p.details?.placeId === hit.details.placeId ||
      (sameName(p.name, hit.name) && !!p.location && !!hit.location && distanceKm(p.location, hit.location) < 0.2);
    const existing = this.store.data.places.find((p) => p.list.toLowerCase() === list.toLowerCase() && same(p));
    if (existing) throw new Error(`${existing.name} is already in ${existing.list}.`);
    const place: SavedPlace = {
      key: `chat-${randomUUID().slice(0, 8)}`,
      list: this.store.data.lists.find((l) => l.name.toLowerCase() === list.toLowerCase())?.name ?? list,
      name: hit.name,
      address: hit.address,
      location: hit.location,
      note: note?.trim() || undefined,
      mapsUrl: hit.mapsUrl,
      source: 'chat',
      details: hit.details,
    };
    this.store.data.places.push(place);
    this.store.save();
    return place;
  }

  /** Looks a place up on Google without saving it: up to three matches near an area. */
  async lookup(query: string, near?: LatLng): Promise<FoundPlace[]> {
    if (!this.api) throw new Error('Looking up a place needs GOOGLE_MAPS_API_KEY; search the web instead.');
    return this.api.lookup(query, near ?? (await this.home()));
  }

  remove(key: string): SavedPlace {
    const place = this.store.data.places.find((p) => p.key === key);
    if (!place) throw new Error(`No saved place with key "${key}".`);
    if (place.source === 'list') throw new Error(`${place.name} comes from the "${place.list}" list in Google Maps; remove it there and it drops out on the next sync.`);
    this.store.data.places = this.store.data.places.filter((p) => p !== place);
    this.store.save();
    return place;
  }
}
