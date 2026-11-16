/**
 * Google Calendar as tools: list events across every visible calendar, and
 * (chat only) create, edit and delete them. Event lines carry both the
 * calendar id and event id because edits need the pair.
 */
import type { ToolHandler } from './llm.js';
import type { GoogleAccount } from './google.js';
import { addLocalDays, toLocalShort } from './time.js';

const CAL = 'https://www.googleapis.com/calendar/v3';
const EVENT_CAP = 50;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

interface EventTime {
  date?: string;
  dateTime?: string;
  /** The zone the event was made in; its times are shown in it. */
  timeZone?: string;
}
export interface CalendarEvent {
  id: string;
  summary?: string;
  location?: string;
  start?: EventTime;
  end?: EventTime;
}
interface CalendarEntry {
  id: string;
  summary?: string;
  summaryOverride?: string;
  hidden?: boolean;
  selected?: boolean;
}

const calPath = (calendarId: string) => `${CAL}/calendars/${encodeURIComponent(calendarId.trim() || 'primary')}/events`;

function instant(value: string, field: string): Date {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error(`${field} is not a valid ISO date-time: ${value}`);
  return d;
}

/** An IANA zone name, or an error the model can act on. */
function zoneArg(value: unknown, fallback: string): string {
  const zone = String(value ?? '').trim();
  if (!zone) return fallback;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
  } catch {
    throw new Error(`time_zone is not an IANA zone name such as Asia/Tokyo: ${zone}`);
  }
  return zone;
}

/**
 * All-day events show as dates (end is exclusive, so a one-day event is just
 * its date). Timed events show in the zone they were made in, named when it
 * isn't the owner's: a 4 PM check-in in Tokyo reads as 16:00, not as the
 * midnight it is in California.
 */
export function when(e: CalendarEvent, timeZone: string): string {
  if (e.start?.date) {
    const lastDay = e.end?.date ? new Date(Date.parse(`${e.end.date}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10) : e.start.date;
    return lastDay > e.start.date ? `${e.start.date} to ${lastDay} (all day)` : `${e.start.date} (all day)`;
  }
  const zone = e.start?.timeZone || timeZone;
  const start = e.start?.dateTime ? toLocalShort(new Date(e.start.dateTime), zone) : '?';
  const end = e.end?.dateTime ? toLocalShort(new Date(e.end.dateTime), zone) : '?';
  return zone === timeZone ? `${start} – ${end}` : `${start} – ${end} ${zone} time`;
}

const startMs = (e: CalendarEvent) => Date.parse(e.start?.dateTime ?? `${e.start?.date}T00:00:00Z`);

/** Events across every visible calendar between two instants, soonest first. */
export async function listEvents(account: GoogleAccount, from: Date, to: Date, query = ''): Promise<{ e: CalendarEvent; cal: CalendarEntry }[]> {
  const list = await account.api<{ items?: CalendarEntry[] }>(`${CAL}/users/me/calendarList`);
  const calendars = (list.items ?? []).filter((c) => !c.hidden && c.selected !== false);
  const perCalendar = await Promise.all(
    calendars.map(async (c) => {
      const res = await account.api<{ items?: CalendarEvent[] }>(calPath(c.id), {
        params: {
          timeMin: from.toISOString(),
          timeMax: to.toISOString(),
          singleEvents: true,
          orderBy: 'startTime',
          maxResults: EVENT_CAP,
          ...(query ? { q: query } : {}),
        },
      });
      return (res.items ?? []).map((e) => ({ e, cal: c }));
    }),
  );
  return perCalendar.flat().sort((a, b) => startMs(a.e) - startMs(b.e));
}

export function calendarTools(account: GoogleAccount, timeZone: string, readOnly: boolean): ToolHandler[] {
  const tools: ToolHandler[] = [
    {
      def: {
        name: 'calendar_events',
        description:
          "List events across the owner's calendars between two times, optionally matching text. Each line has the calendar id and event id needed to edit it.",
        strict: true,
        input_schema: {
          type: 'object',
          properties: {
            from: { type: 'string', description: 'ISO date-time with offset; empty string for now.' },
            to: { type: 'string', description: 'ISO date-time with offset; empty string for 7 days after from.' },
            query: { type: 'string', description: 'Free-text match; | between alternatives ("Tokyo|Osaka"); empty string for all.' },
          },
          required: ['from', 'to', 'query'],
          additionalProperties: false,
        },
      },
      run: async (args) => {
        const from = args.from ? instant(String(args.from), 'from') : new Date();
        const to = args.to ? instant(String(args.to), 'to') : addLocalDays(from, 7, timeZone);
        const query = String(args.query ?? '').trim();
        const alternatives = [...new Set(query.split('|').map((q) => q.trim()).filter(Boolean))];
        const found = alternatives.length > 1 ? (await Promise.all(alternatives.map((q) => listEvents(account, from, to, q)))).flat() : await listEvents(account, from, to, query);
        const seen = new Set<string>();
        const all = found.filter(({ e, cal }) => !seen.has(`${cal.id}/${e.id}`) && !!seen.add(`${cal.id}/${e.id}`)).sort((a, b) => startMs(a.e) - startMs(b.e));
        if (!all.length) return 'No events in that range.';
        const lines = all.slice(0, EVENT_CAP).map(({ e, cal }) =>
          [`${cal.id} / ${e.id}`, when(e, timeZone), e.summary || '(no title)', e.location, cal.summaryOverride || cal.summary]
            .filter(Boolean)
            .join(' · '),
        );
        if (all.length > EVENT_CAP) lines.push(`(${all.length - EVENT_CAP} more; narrow the range)`);
        return lines.join('\n');
      },
    },
  ];
  if (readOnly) return tools;

  const calendarIdProp = { type: 'string', description: 'Calendar id from calendar_events; empty string for the primary calendar.' };
  const timeZoneProp = {
    type: 'string',
    description: `IANA zone the event happens in, such as Asia/Tokyo for a hotel stay in Japan, so it shows in local time there; empty string for ${timeZone}.`,
  };
  const eventIdProp = { type: 'string', description: 'Event id from calendar_events.' };

  tools.push(
    {
      def: {
        name: 'calendar_create_event',
        description: 'Create a calendar event. Timed events take ISO date-times with offset; all-day events take YYYY-MM-DD.',
        strict: true,
        input_schema: {
          type: 'object',
          properties: {
            calendar_id: calendarIdProp,
            summary: { type: 'string', description: 'Event title.' },
            start: { type: 'string', description: 'ISO date-time with offset, or YYYY-MM-DD when all_day.' },
            end: {
              type: 'string',
              description: 'ISO date-time with offset, or for all_day the day after the last day (exclusive); empty string for a one-day all-day event.',
            },
            all_day: { type: 'boolean', description: 'True for an all-day event.' },
            time_zone: timeZoneProp,
            location: { type: 'string', description: 'Location, or empty string.' },
            description: { type: 'string', description: 'Notes, or empty string.' },
          },
          required: ['calendar_id', 'summary', 'start', 'end', 'all_day', 'time_zone', 'location', 'description'],
          additionalProperties: false,
        },
      },
      run: async (args) => {
        const start = String(args.start ?? '').trim();
        let end = String(args.end ?? '').trim();
        let times: { start: EventTime; end: EventTime };
        if (args.all_day) {
          if (!DAY.test(start) || (end && !DAY.test(end))) throw new Error('All-day events take start and end as YYYY-MM-DD.');
          if (!end || end <= start) end = new Date(Date.parse(`${start}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
          times = { start: { date: start }, end: { date: end } };
        } else {
          const s = instant(start, 'start');
          const e = instant(end, 'end');
          if (e <= s) throw new Error('end must be after start.');
          const zone = zoneArg(args.time_zone, timeZone);
          times = { start: { dateTime: s.toISOString(), timeZone: zone }, end: { dateTime: e.toISOString(), timeZone: zone } };
        }
        const event = await account.api<CalendarEvent>(calPath(String(args.calendar_id ?? '')), {
          method: 'POST',
          body: {
            summary: String(args.summary ?? ''),
            ...times,
            ...(args.location ? { location: String(args.location) } : {}),
            ...(args.description ? { description: String(args.description) } : {}),
          },
        });
        return `Created "${event.summary ?? ''}" ${when(event, timeZone)} (event id ${event.id}).`;
      },
    },
    {
      def: {
        name: 'calendar_update_event',
        description: 'Change an existing event. Only non-empty fields are changed. Times must match the event kind (ISO with offset for timed, YYYY-MM-DD for all-day).',
        strict: true,
        input_schema: {
          type: 'object',
          properties: {
            calendar_id: calendarIdProp,
            event_id: eventIdProp,
            summary: { type: 'string', description: 'New title, or empty string.' },
            start: { type: 'string', description: 'New start, or empty string.' },
            end: { type: 'string', description: 'New end, or empty string.' },
            time_zone: { ...timeZoneProp, description: `${timeZoneProp.description} Applies to the new start and end.` },
            location: { type: 'string', description: 'New location, or empty string.' },
            description: { type: 'string', description: 'New notes, or empty string.' },
          },
          required: ['calendar_id', 'event_id', 'summary', 'start', 'end', 'time_zone', 'location', 'description'],
          additionalProperties: false,
        },
      },
      run: async (args) => {
        const eventId = String(args.event_id ?? '').trim();
        if (!eventId) throw new Error('event_id is required.');
        const zone = zoneArg(args.time_zone, timeZone);
        const time = (v: string, field: string): EventTime =>
          DAY.test(v) ? { date: v } : { dateTime: instant(v, field).toISOString(), timeZone: zone };
        const patch: Record<string, unknown> = {};
        for (const key of ['summary', 'location', 'description'] as const) if (args[key]) patch[key] = String(args[key]);
        if (args.start) patch.start = time(String(args.start), 'start');
        if (args.end) patch.end = time(String(args.end), 'end');
        if (!Object.keys(patch).length) throw new Error('Nothing to change.');
        const event = await account.api<CalendarEvent>(`${calPath(String(args.calendar_id ?? ''))}/${encodeURIComponent(eventId)}`, {
          method: 'PATCH',
          body: patch,
        });
        return `Updated "${event.summary ?? ''}" ${when(event, timeZone)}.`;
      },
    },
    {
      def: {
        name: 'calendar_delete_event',
        description: 'Delete an event. Only when the owner explicitly asks.',
        strict: true,
        input_schema: {
          type: 'object',
          properties: { calendar_id: calendarIdProp, event_id: eventIdProp },
          required: ['calendar_id', 'event_id'],
          additionalProperties: false,
        },
      },
      run: async (args) => {
        const eventId = String(args.event_id ?? '').trim();
        if (!eventId) throw new Error('event_id is required.');
        await account.api(`${calPath(String(args.calendar_id ?? ''))}/${encodeURIComponent(eventId)}`, { method: 'DELETE' });
        return `Deleted event ${eventId}.`;
      },
    },
  );
  return tools;
}
