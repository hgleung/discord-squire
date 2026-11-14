/**
 * Wall-clock helpers for one IANA time zone, built on Intl so there is no
 * timezone database to ship. Reminders are stored as UTC instants; these turn
 * them into the local times the model reads and writes, and move a repeating
 * reminder forward by calendar days so 8am stays 8am across a DST change.
 */

/** The zone the bot's own machine is in, e.g. "America/Los_Angeles". */
export const systemTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

interface WallClock {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function wallClock(date: Date, timeZone: string): WallClock {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute'), second: get('second') };
}

/** Minutes the zone is ahead of UTC at that instant (e.g. -480 for PST). */
export function offsetMinutes(date: Date, timeZone: string): number {
  const w = wallClock(date, timeZone);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000);
}

/** The instant at which the zone's clock reads the given wall time. */
function fromWallClock(w: WallClock, timeZone: string): Date {
  const guess = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  // Offset at the guess, then again at the corrected instant: the second pass
  // settles the hour either side of a DST change.
  let t = guess - offsetMinutes(new Date(guess), timeZone) * 60000;
  t = guess - offsetMinutes(new Date(t), timeZone) * 60000;
  return new Date(t);
}

/** Same local time of day, `days` calendar days later. */
export function addLocalDays(date: Date, days: number, timeZone: string): Date {
  const w = wallClock(date, timeZone);
  const shifted = new Date(Date.UTC(w.year, w.month - 1, w.day + days));
  return fromWallClock(
    { ...w, year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() },
    timeZone,
  );
}

const pad = (n: number) => String(n).padStart(2, '0');

/** ISO 8601 with the zone's offset, e.g. "2026-11-12T13:51:00-08:00". */
export function toLocalIso(date: Date, timeZone: string): string {
  const w = wallClock(date, timeZone);
  const off = offsetMinutes(date, timeZone);
  const sign = off < 0 ? '-' : '+';
  const abs = Math.abs(off);
  return `${w.year}-${pad(w.month)}-${pad(w.day)}T${pad(w.hour)}:${pad(w.minute)}:${pad(w.second)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** Short human form for chat, e.g. "Thu 12 Nov, 13:51". */
export function toLocalShort(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(date);
}
