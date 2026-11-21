import type { ToolHandler } from './llm.js';
import type { GoogleAccount } from './google.js';
import { listEvents } from './calendarTools.js';
import { distanceKm, KM_PER_MILE, isOpenAt, todaysHours, type FoundPlace, type LatLng, type SavedPlace, type SavedPlaces } from './places.js';
import { toLocalIso, toLocalShort } from './time.js';

const PRICE: Record<string, string> = {
  PRICE_LEVEL_FREE: 'free',
  PRICE_LEVEL_INEXPENSIVE: '$',
  PRICE_LEVEL_MODERATE: '$$',
  PRICE_LEVEL_EXPENSIVE: '$$$',
  PRICE_LEVEL_VERY_EXPENSIVE: '$$$$',
};

/** One line per place: everything the model needs to pick and to link it. */
function describe(p: SavedPlace, at: Date, from?: LatLng): string {
  const open = isOpenAt(p.details, at);
  const hours = todaysHours(p.details, at)?.replace(/^\w+:\s*/, '');
  return [
    p.name,
    p.list,
    from && p.location ? `${(distanceKm(from, p.location) / KM_PER_MILE).toFixed(1)} mi` : undefined,
    p.details?.status && p.details.status !== 'OPERATIONAL' ? p.details.status.toLowerCase().replace(/_/g, ' ') : undefined,
    open === undefined ? 'hours unknown' : `${open ? 'open now' : 'closed now'}${hours ? ` (today ${hours})` : ''}`,
    p.details?.rating ? `★${p.details.rating}` : undefined,
    p.details?.priceLevel ? PRICE[p.details.priceLevel] : undefined,
    p.details?.type,
    p.address,
    p.note ? `note: ${p.note}` : undefined,
    p.source === 'chat' ? `added by chat, key ${p.key}` : undefined,
    p.mapsUrl,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** A looked-up place: the saved-place line, plus the week's hours so they can be written down. */
export function lookedUp(h: FoundPlace, at: Date, from?: LatLng): string {
  const line = describe({ key: '', list: 'not saved', name: h.name, address: h.address, location: h.location, mapsUrl: h.mapsUrl, source: 'list', details: h.details }, at, from);
  const week = h.details.weekdayHours?.length ? `\n  hours: ${h.details.weekdayHours.join('; ')}` : '';
  return `${line}${week}`;
}

const matchesList = (p: SavedPlace, list: string) => !list || p.list.toLowerCase().startsWith(list.toLowerCase());

export function placesPrompt(places: SavedPlaces, opts: { readOnly?: boolean } = {}): string {
  const lists = places.lists().map((l) => l.name);
  return `
Saved places:
- Your owner keeps Google Maps lists of places they like or want to try${lists.length ? `: ${lists.join(', ')}` : ''}. For anything about where to eat, drink, get dessert or coffee, or hang out, check them first with places_find and lead with a saved spot that fits. Search the web only when nothing saved fits or they want something new.
- places_find returns up to 25 at a time: page with offset (25, 50, ...) instead of saying it can't. For "a cafe I haven't been to", read the been-to note, pass those names as exclude, and the result is the exact remainder of the saved list; show the first few and say how many are left.
- "Near me" means home unless the conversation or their calendar says they're somewhere else. For a trip or a plan on a date, look at calendar_events to see where they'll be, and search near there.
- To find where a shop, restaurant or brand's store is, or its hours, use places_lookup (one call per place, near set to the city or area) before the web: it returns Google Maps' own address, hours and link. Search the web only for what Maps doesn't have.
- A name from a reel or a voice note is often spelled the way it sounds ("Ah-fu-ri" for AFURI, "Blue Dore" for Blue Door). Before saying a place can't be found, check the owner's notes and saved places for a similar name (search_notes, places_find), then try the spellings it could be, its Japanese or local name, and "<name> flagship <city>". Say which match you went with, and that it's a match by sound when it is.
- Say why a spot fits in a few words (their note, distance, open now) and include its Maps link. If its hours are unknown, say so rather than guessing.` +
    (opts.readOnly
      ? ''
      : `
- When they share a place (a reel, a link, a name) without saying what to do, save it with places_add right away, to the existing list that fits (a restaurant goes in food). Don't start a new list unless they ask for one, by name or by where it goes ("save these for the Japan trip" means a Japan trip list).
- Set near to the city or area the post names ("Harajuku, Tokyo", "Chicago"); left empty it searches near home. If the post gives an address, or the match isn't the place the post means, search by that address instead of the name. Put the context in the note: the trip it's for, if your journal or notes show one there, and what the reel or post recommended.
- places_add saves to Squire's copy only: Google has no way to write to Maps lists. Give the place's Maps link so they can tap Save on their phone, and mention the Squire-only part once in a conversation, not with every place.`);
}

export function placesTools(
  places: SavedPlaces,
  timeZone: string,
  opts: { readOnly?: boolean; clock?: () => Date } = {},
): ToolHandler[] {
  const clock = opts.clock ?? (() => new Date());
  const tools: ToolHandler[] = [
    {
      def: {
        name: 'places_lists',
        description: "The owner's saved Google Maps lists: names, how many places each, and when each was last read.",
        strict: true,
        input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
      },
      run() {
        const lists = places.lists();
        if (lists.length === 0) return 'No lists are set up.';
        const lines = lists.map((l) => {
          const count = places.places().filter((p) => p.list === l.name).length;
          const when = l.syncedAt ? `read ${toLocalShort(new Date(l.syncedAt), timeZone)}` : 'never read';
          return `${l.name} · ${count} places · ${when}${l.error ? ` · last read failed: ${l.error}` : ''}`;
        });
        const orphans = [...new Set(places.places().filter((p) => !lists.some((l) => l.name === p.list)).map((p) => p.list))];
        if (orphans.length) lines.push(`Added by chat only: ${orphans.join(', ')}`);
        return lines.join('\n');
      },
    },
    {
      def: {
        name: 'places_find',
        description:
          "Search the owner's saved places. Filter by list, by words in the name, note, type or address, by distance from somewhere, and by open now. " +
          'Results are nearest first when "near" is given, otherwise best rated first.',
        strict: true,
        input_schema: {
          type: 'object',
          properties: {
            list: { type: 'string', description: 'List name or its start ("food", "bars"); empty string for all lists.' },
            text: { type: 'string', description: 'Words to match ("ramen", "rooftop", "matcha"); empty string for anything.' },
            near: { type: 'string', description: '"home", a place or area ("Union Square SF", "the Chicago Loop"), or empty string for anywhere.' },
            within_miles: { type: 'number', description: 'Only places this many miles from "near" or closer; 0 for no limit.' },
            open_now: { type: 'boolean', description: 'Only places open right now (places with unknown hours are left out and counted).' },
            limit: { type: 'integer', description: 'How many to return, 1-25.' },
            offset: { type: 'integer', description: 'Skip this many results, to page: 25 for the next 25 after a full page; 0 for the first.' },
            exclude: { type: 'array', items: { type: 'string' }, description: 'Names to leave out (places already visited, from a note), matched by name containing it; empty array for none.' },
          },
          required: ['list', 'text', 'near', 'within_miles', 'open_now', 'limit', 'offset', 'exclude'],
          additionalProperties: false,
        },
      },
      async run(args) {
        const now = clock();
        const list = String(args.list ?? '').trim();
        const words = String(args.text ?? '').toLowerCase().split(/\s+/).filter(Boolean);
        const nearText = String(args.near ?? '').trim();
        const within = (Number(args.within_miles) || 0) * KM_PER_MILE;
        const limit = Math.min(25, Math.max(1, Number(args.limit) || 10));

        const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
        const exclude = (Array.isArray(args.exclude) ? args.exclude : []).map((x) => String(x).trim().toLowerCase()).filter(Boolean);

        let from: (LatLng & { label?: string }) | undefined;
        if (nearText.toLowerCase() === 'home') {
          from = await places.home();
          if (!from) throw new Error("Home isn't known (ASSISTANT_LOCATION unset, or no GOOGLE_MAPS_API_KEY to place it). Ask where they are.");
        } else if (nearText) {
          from = await places.locate(nearText);
          if (!from) throw new Error(`Couldn't place "${nearText}" on the map. Try a fuller name or a neighbourhood and city.`);
        }

        let hits = places.places().filter((p) => {
          if (!matchesList(p, list)) return false;
          const hay = [p.name, p.note, p.address, p.details?.type, p.list].join(' ').toLowerCase();
          return words.every((w) => hay.includes(w));
        });
        if (hits.length === 0) {
          const names = places.lists().map((l) => l.name).join(', ');
          return `No saved places match.${list ? ` Lists are: ${names}.` : ''}`;
        }
        if (exclude.length) hits = hits.filter((p) => !exclude.some((x) => p.name.toLowerCase().includes(x)));
        if (from && within > 0) hits = hits.filter((p) => p.location && distanceKm(from, p.location) <= within);
        let unknownHours = 0;
        if (args.open_now === true) {
          hits = hits.filter((p) => {
            const open = isOpenAt(p.details, now);
            if (open === undefined) unknownHours += 1;
            return open === true;
          });
        }
        hits.sort((a, b) =>
          from
            ? (a.location ? distanceKm(from, a.location) : Infinity) - (b.location ? distanceKm(from, b.location) : Infinity)
            : (b.details?.rating ?? 0) - (a.details?.rating ?? 0),
        );
        const header = from?.label ? `Near ${from.label}:` : '';
        const lines = hits.slice(offset, offset + limit).map((p) => describe(p, now, from));
        if (offset > 0 && lines.length === 0) return `Nothing past ${offset}: only ${hits.length} match.`;
        if (hits.length > offset + limit) lines.push(`(${hits.length - offset - limit} more: offset ${offset + limit} for the next page)`);
        if (unknownHours) lines.push(`(${unknownHours} matching places left out: hours unknown)`);
        return [header, ...lines].filter(Boolean).join('\n') || 'Nothing saved fits that.';
      },
    },
    {
      def: {
        name: 'places_lookup',
        description:
          "Look a place up on Google Maps without saving it: up to three matches with address, this week's hours, rating and Maps link. For where a shop or brand's store is, or when it's open.",
        strict: true,
        input_schema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'The place, with enough to find it: "Blue Door flagship Harajuku Tokyo", "Tartine Bakery San Francisco".' },
            near: { type: 'string', description: 'City or area to search around ("Harajuku, Tokyo"), or empty string for near home.' },
          },
          required: ['query', 'near'],
          additionalProperties: false,
        },
      },
      async run(args) {
        const query = String(args.query ?? '').trim();
        if (!query) throw new Error('Say which place to look up.');
        const nearText = String(args.near ?? '').trim();
        const near = nearText && nearText.toLowerCase() !== 'home' ? await places.locate(nearText) : undefined;
        if (nearText && nearText.toLowerCase() !== 'home' && !near) throw new Error(`Couldn't place "${nearText}" on the map. Try a fuller area name and city.`);
        const hits = await places.lookup(query, near);
        if (hits.length === 0) return `Google Maps found nothing for "${query}". Try another spelling, the local-language name, or the street address.`;
        // Only biased to the area, so a namesake elsewhere can come first: say how far each is.
        return hits.map((h) => lookedUp(h, clock(), near)).join('\n');
      },
    },
  ];
  if (opts.readOnly) return tools;
  tools.push(
    {
      def: {
        name: 'places_add',
        description:
          "Save a place to one of the owner's lists in Squire's copy (Google Maps itself isn't changed). Looks it up on Google for its address and hours.",
        strict: true,
        input_schema: {
          type: 'object',
          properties: {
            list: { type: 'string', description: 'An existing list that fits, e.g. "food".' },
            query: { type: 'string', description: 'The place to look up, with enough to find it: "Tartine Bakery San Francisco".' },
            near: { type: 'string', description: 'Area to search around ("home" or a place), or empty string for near home.' },
            note: { type: 'string', description: 'Why they saved it ("get the morning bun"), or empty string.' },
            new_list: { type: 'boolean', description: 'True only when the owner asked for a new list by that name.' },
          },
          required: ['list', 'query', 'near', 'note', 'new_list'],
          additionalProperties: false,
        },
      },
      async run(args) {
        const nearText = String(args.near ?? '').trim();
        const near = nearText && nearText.toLowerCase() !== 'home' ? await places.locate(nearText) : undefined;
        const list = String(args.list ?? '').trim();
        if (!list) throw new Error('Say which list to add it to.');
        const known = [...new Set([...places.lists().map((l) => l.name), ...places.places().map((p) => p.list)])];
        if (args.new_list !== true && !known.some((l) => l.toLowerCase() === list.toLowerCase())) {
          throw new Error(`There's no "${list}" list. Lists: ${known.join(', ')}. Use the one that fits; a new list only if the owner asked for one.`);
        }
        const p = await places.add(list, String(args.query ?? ''), near, String(args.note ?? ''));
        return `Added to ${p.list} (Squire only): ${describe(p, clock())}`;
      },
    },
    {
      def: {
        name: 'places_remove',
        description: 'Remove a place that was added by chat, by its key from places_find. Places from Google Maps lists must be removed in Maps.',
        strict: true,
        input_schema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'], additionalProperties: false },
      },
      run(args) {
        const p = places.remove(String(args.key ?? ''));
        return `Removed ${p.name} from ${p.list}.`;
      },
    },
  );
  return tools;
}

/** How far from home a calendar event's place must be to count as a trip. */
const TRIP_KM = 80;
/** How far from the destination a saved place may be to be suggested. */
const DESTINATION_KM = 25;
const DIGEST_PER_LIST = 4;

/**
 * On the first morning of a trip, the saved spots at the destination. A trip
 * is a calendar event today whose location (or title, for an all-day event
 * like "Stay at a hotel in Chicago") is far from home. Each event gets one
 * digest; returns the messages to post.
 */
export async function tripDigests(places: SavedPlaces, account: GoogleAccount, timeZone: string, now = new Date()): Promise<string[]> {
  const home = await places.home();
  if (!home) return [];
  const today = toLocalIso(now, timeZone).slice(0, 10);
  const events = await listEvents(account, new Date(now.getTime() - 86_400_000), new Date(now.getTime() + 86_400_000));
  const notified = new Set(places.store.data.tripsNotified);
  const digests: string[] = [];
  for (const { e } of events) {
    const startDay = e.start?.date ?? (e.start?.dateTime ? toLocalIso(new Date(e.start.dateTime), timeZone).slice(0, 10) : undefined);
    if (startDay !== today || notified.has(e.id)) continue;
    const where = e.location?.trim() || (e.start?.date ? e.summary?.trim() : undefined);
    if (!where) continue;
    const dest = await places.locate(where);
    if (!dest || distanceKm(home, dest) < TRIP_KM) continue;

    const nearby = places.places().filter((p) => p.location && distanceKm(dest, p.location) <= DESTINATION_KM);
    places.store.data.tripsNotified.push(e.id);
    places.store.save();
    if (nearby.length === 0) continue;

    const byList = new Map<string, SavedPlace[]>();
    for (const p of nearby) byList.set(p.list, [...(byList.get(p.list) ?? []), p]);
    const lines = [...byList].map(([list, ps]) => {
      const top = ps
        .sort((a, b) => (b.details?.rating ?? 0) - (a.details?.rating ?? 0))
        .slice(0, DIGEST_PER_LIST)
        .map((p) => `[${p.name.replace(/[[\]]/g, '')}](<${p.mapsUrl}>)`);
      return `**${list}** (${ps.length}): ${top.join(' · ')}`;
    });
    digests.push(`🧳 **${e.summary ?? 'Trip'}** starts today. You've saved ${nearby.length} spot${nearby.length === 1 ? '' : 's'} near ${dest.label}:\n${lines.join('\n')}`);
  }
  return digests;
}
