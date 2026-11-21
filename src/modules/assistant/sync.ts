import { BOT_FOLDER, noteFileName, type Vault } from '../../vault.js';
import type { GoogleAccount } from './google.js';
import { listEvents, when, type CalendarEvent } from './calendarTools.js';
import { addedBySquire } from './inboxEvents.js';
import type { SavedPlace } from './places.js';
import { noteFields } from './taskNotes.js';
import { toLocalIso } from './time.js';

/**
 * Read-only snapshots of outside data, as notes in Squire/Sync/ that the
 * owner can browse and Squire can search without a live call:
 *
 *   Calendar.md     the next 60 days of events (title, time, place; no descriptions)
 *   Bookings.md     booking emails (subject facts and a Gmail link, never bodies)
 *                   and the events Squire added from mail
 *   Places/<name>   one place note per Google Maps saved spot
 *   Sync status.md  when each source last synced, and how many items
 *
 * Nothing is written outside Squire/Sync, nothing in Gmail, Calendar or Maps
 * is changed, and nothing costs model calls. Unchanged notes aren't
 * rewritten, so a sync with nothing new only touches Sync status.md. A place
 * note is rewritten only while it still says `sync: maps`; take that line out
 * and it's yours. Nothing is deleted when it leaves the source.
 */

export const SYNC_FOLDER = `${BOT_FOLDER}/Sync`;
export const SYNC_STATUS = `${SYNC_FOLDER}/Sync status.md`;
const CALENDAR_DAYS = 60;
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
/** Gmail's own booking category: flights, hotels, restaurants, tickets. */
const BOOKINGS_QUERY = 'category:reservations newer_than:365d';
const BOOKINGS_MAX = 100;

/** The prompt line: snapshots first, live tools for anything newer. */
export const SYNC_PROMPT = `- ${SYNC_FOLDER} holds read-only snapshots: Calendar (next ${CALENDAR_DAYS} days), Bookings (booking emails, links only) and Places (your Google Maps saved spots), with the last sync time in "${SYNC_STATUS}". Read them for a quick look; use the live calendar, Gmail and places tools when you need anything newer than the last sync, or detail the snapshot leaves out. Never edit ${SYNC_FOLDER}.`;

const cell = (s: string | undefined) => (s ?? '').replace(/\|/g, '/').replace(/\s+/g, ' ').trim();

/**
 * A booking email's subject with anything that looks like an identifier taken
 * out: confirmation codes, booking and card numbers (any run of 5+ letters and
 * digits that has a digit, and any 4+ digit number that isn't a year).
 */
export function scrubSubject(subject: string): string {
  return subject
    .replace(/\b(?=[A-Z0-9-]*\d)[A-Z0-9][A-Z0-9-]{4,}\b/gi, (m) => (/^(?:19|20)\d{2}$/.test(m) ? m : ''))
    .replace(/\b\d{5,}\b/g, '')
    .replace(/\b(?!(?:19|20)\d{2}\b)\d{4}\b/g, '')
    .replace(/(?:#|\b(?:no\.?|number|code|ref(?:erence)?):?)(?=\s*(?:$|[,.:;)\s]))/gi, '')
    .replace(/\s+([,.:;)])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** The sender's display name only, never the address. */
export function senderName(from: string): string {
  const name = /^\s*"?([^"<]*?)"?\s*</.exec(from)?.[1]?.trim();
  return name || (from.split('@')[1]?.replace(/>.*$/, '') ?? '');
}

export function calendarNote(events: { e: CalendarEvent; calendar: string }[], timeZone: string, now: Date): string {
  const rows = events.map(({ e, calendar }) => `| ${cell(when(e, timeZone))} | ${cell(e.summary) || '(no title)'} | ${cell(e.location)} | ${cell(calendar)} |`);
  return `---\ntype: note\ntags: [squire-sync]\nsource: google-calendar\n---\n\n# Calendar, next ${CALENDAR_DAYS} days\n\nA read-only snapshot from ${toLocalIso(now, timeZone).slice(0, 10)}; descriptions and guests are left out. Squire rewrites this note on each sync.\n\n| When | Event | Where | Calendar |\n|---|---|---|---|\n${rows.join('\n') || '| | nothing scheduled | | |'}\n`;
}

export interface BookingMail {
  id: string;
  date: string;
  from: string;
  subject: string;
}

export function bookingsNote(mail: BookingMail[], fromMail: CalendarEvent[], timeZone: string): string {
  const upcoming = fromMail.map((e) => `| ${cell(when(e, timeZone))} | ${cell(e.summary)} | ${cell(e.location)} |`);
  const rows = mail.map((m) => `| ${m.date} | ${cell(senderName(m.from))} | ${cell(scrubSubject(m.subject))} | [open](https://mail.google.com/mail/u/0/#all/${m.id}) |`);
  return `---\ntype: note\ntags: [squire-sync]\nsource: gmail\n---\n\n# Bookings\n\nFrom Gmail's Reservations category and the events Squire added to your calendar from email. Only the subject (with confirmation and card numbers taken out) and a link are kept; open the email for the details. Squire rewrites this note on each sync.\n\n## Upcoming, added from email\n\n| When | Event | Where |\n|---|---|---|\n${upcoming.join('\n') || '| | none | |'}\n\n## Booking emails, last 12 months\n\n| Received | From | Subject | Email |\n|---|---|---|---|\n${rows.join('\n') || '| | | none | |'}\n`;
}

export function placeNote(p: SavedPlace): string {
  const fields: [string, string | number | undefined][] = [
    ['type', 'place'],
    ['category', p.details?.type?.replace(/_/g, ' ')],
    ['address', p.address],
    ['maps', p.mapsUrl],
    ['rating', p.details?.rating],
    ['list', p.list],
    ['sync', 'maps'],
  ];
  const yaml = fields
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}: ${typeof v === 'number' ? v : JSON.stringify(v)}`)
    .join('\n');
  const hours = p.details?.weekdayHours?.length ? `\n## Hours\n\n${p.details.weekdayHours.map((h) => `- ${h}`).join('\n')}\n` : '';
  return `---\n${yaml}\ntags: [squire-sync]\n---\n\n# ${p.name}\n\nFrom your Google Maps list "${p.list}".${p.note ? ` Your note there: ${p.note}` : ''} Squire keeps this note in step with the list while it says \`sync: maps\`; delete that line to keep it as your own.\n${hours}`;
}

/** Writes the place notes. Returns how many it wrote and the ones it left because they are no longer synced. */
export function writePlaces(vault: Vault, places: SavedPlace[]): { wrote: number; kept: string[] } {
  let wrote = 0;
  const kept: string[] = [];
  const seen = new Set<string>();
  for (const p of places.filter((x) => x.source === 'list')) {
    let path = `${SYNC_FOLDER}/Places/${noteFileName(p.name)}.md`;
    // Two spots with one name (two branches of a cafe) get the list or address added.
    if (seen.has(path)) path = `${SYNC_FOLDER}/Places/${noteFileName(`${p.name} (${p.address?.split(',')[0] ?? p.list})`)}.md`;
    seen.add(path);
    const existing = vault.read(path);
    if (existing !== undefined && noteFields(existing).sync !== 'maps') {
      kept.push(path);
      continue;
    }
    if (vault.write(path, placeNote(p))) wrote++;
  }
  return { wrote, kept };
}

async function bookingMail(account: GoogleAccount, timeZone: string): Promise<BookingMail[]> {
  const list = await account.api<{ messages?: { id: string }[] }>(`${GMAIL}/messages`, { params: { q: BOOKINGS_QUERY, maxResults: BOOKINGS_MAX } });
  type Meta = { id: string; internalDate?: string; payload?: { headers?: { name: string; value: string }[] } };
  const metas = await Promise.all(
    (list.messages ?? []).map((m) => account.api<Meta>(`${GMAIL}/messages/${m.id}`, { params: { format: 'metadata', metadataHeaders: ['From', 'Subject'] } })),
  );
  const header = (m: Meta, name: string) => m.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';
  return metas.map((m) => ({
    id: m.id,
    date: m.internalDate ? toLocalIso(new Date(Number(m.internalDate)), timeZone).slice(0, 10) : '',
    from: header(m, 'From'),
    subject: header(m, 'Subject') || '(no subject)',
  }));
}

export interface SyncSources {
  google?: GoogleAccount;
  places?: SavedPlace[];
}

/** Runs every sync it has a source for and writes the status note. One failing source doesn't stop the rest. */
export async function runSyncs(vault: Vault, sources: SyncSources, timeZone: string, now = new Date()): Promise<string[]> {
  const status: string[] = [];
  const stamp = toLocalIso(now, timeZone);
  const run = async (name: string, fn: () => Promise<string>) => {
    try {
      status.push(`| ${name} | ${stamp} | ${await fn()} |`);
    } catch (err) {
      status.push(`| ${name} | failed ${stamp} | ${cell(err instanceof Error ? err.message : String(err)).slice(0, 160)} |`);
    }
  };
  const { google, places } = sources;
  if (google) {
    await run('Calendar', async () => {
      const events = await listEvents(google, now, new Date(now.getTime() + CALENDAR_DAYS * 86_400_000));
      vault.write(`${SYNC_FOLDER}/Calendar.md`, calendarNote(events.map(({ e, cal }) => ({ e, calendar: cal.summaryOverride ?? cal.summary ?? cal.id })), timeZone, now));
      return `${events.length} events`;
    });
    await run('Bookings', async () => {
      const mail = await bookingMail(google, timeZone);
      const events = (await listEvents(google, now, new Date(now.getTime() + 365 * 86_400_000))).map((x) => x.e).filter(addedBySquire);
      vault.write(`${SYNC_FOLDER}/Bookings.md`, bookingsNote(mail, events, timeZone));
      return `${mail.length} emails, ${events.length} upcoming from email`;
    });
  }
  if (places) {
    await run('Places', async () => {
      const { wrote, kept } = writePlaces(vault, places);
      return `${places.filter((p) => p.source === 'list').length} places, ${wrote} written${kept.length ? `, ${kept.length} left alone (no longer sync: maps)` : ''}`;
    });
  }
  if (!status.length) return status;
  vault.write(SYNC_STATUS, `---\ntype: note\ntags: [squire-sync]\nlast_sync: ${JSON.stringify(stamp)}\n---\n\n# Sync status\n\nRead-only syncs into ${SYNC_FOLDER}. Nothing here changes Gmail, Calendar or Maps.\n\n| Source | Last sync | Result |\n|---|---|---|\n${status.join('\n')}\n`);
  return status;
}
