import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { addLocalDays } from './time.js';

export type Repeat = 'none' | 'daily' | 'weekdays' | 'weekly' | 'monthly';

export interface Reminder {
  id: string;
  /** What to say when it fires, written for the owner. */
  text: string;
  /** Next time it fires, as a UTC ISO string. */
  due: string;
  repeat: Repeat;
  /** Where it was set, which is also where it fires. */
  channelId: string;
  createdAt: string;
}

/**
 * Reminders kept in a small JSON file so they survive a restart or the PC
 * being off. Every change is written through immediately, via a temp file and
 * a rename, so a crash mid-write can't leave half a file behind.
 */
export class ReminderStore {
  private reminders: Reminder[] = [];

  constructor(
    private readonly path: string,
    private readonly timeZone: string,
  ) {
    if (existsSync(path)) {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as { reminders?: Reminder[] };
      this.reminders = parsed.reminders ?? [];
    }
  }

  get file(): string {
    return this.path;
  }

  list(): Reminder[] {
    return [...this.reminders].sort((a, b) => a.due.localeCompare(b.due));
  }

  add(input: { text: string; due: Date; repeat: Repeat; channelId: string }, now = new Date()): Reminder {
    const reminder: Reminder = {
      id: randomUUID().slice(0, 8),
      text: input.text,
      due: input.due.toISOString(),
      repeat: input.repeat,
      channelId: input.channelId,
      createdAt: now.toISOString(),
    };
    this.reminders.push(reminder);
    this.save();
    return reminder;
  }

  cancel(id: string): Reminder | undefined {
    const found = this.reminders.find((r) => r.id === id);
    if (!found) return undefined;
    this.reminders = this.reminders.filter((r) => r.id !== id);
    this.save();
    return found;
  }

  /**
   * Removes and returns what is due at `now`. A repeating reminder stays,
   * moved to its next occurrence after `now` — so one that was missed while
   * the bot was off fires once, late, rather than once per missed day.
   */
  takeDue(now = new Date()): Reminder[] {
    const due = this.reminders.filter((r) => new Date(r.due) <= now);
    if (due.length === 0) return [];
    const keep = this.reminders.filter((r) => new Date(r.due) > now);
    for (const r of due) {
      if (r.repeat === 'none') continue;
      keep.push({ ...r, due: nextOccurrence(new Date(r.due), r.repeat, this.timeZone, now).toISOString() });
    }
    this.reminders = keep;
    this.save();
    return due;
  }

  private save() {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify({ reminders: this.reminders }, null, 2));
    renameSync(tmp, this.path);
  }
}

/** The first occurrence of a repeating reminder strictly after `after`. */
export function nextOccurrence(from: Date, repeat: Exclude<Repeat, 'none'>, timeZone: string, after: Date): Date {
  let next = from;
  // Bounded so a corrupt date can't spin forever; ten years of dailies is plenty.
  for (let i = 0; i < 4000 && next <= after; i++) {
    next = step(next, repeat, timeZone);
  }
  return next;
}

function step(date: Date, repeat: Exclude<Repeat, 'none'>, timeZone: string): Date {
  switch (repeat) {
    case 'daily':
      return addLocalDays(date, 1, timeZone);
    case 'weekly':
      return addLocalDays(date, 7, timeZone);
    case 'weekdays': {
      let next = addLocalDays(date, 1, timeZone);
      while (isWeekend(next, timeZone)) next = addLocalDays(next, 1, timeZone);
      return next;
    }
    case 'monthly': {
      // Same day next month, clamped: the 31st becomes the 30th or the 28th.
      const day = Number(new Intl.DateTimeFormat('en-US', { timeZone, day: 'numeric' }).format(date));
      let next = addLocalDays(date, 28, timeZone);
      while (localDay(next, timeZone) !== day) {
        const peek = addLocalDays(next, 1, timeZone);
        if (localDay(peek, timeZone) === 1) break; // month ran out first
        next = peek;
      }
      return next;
    }
  }
}

const localDay = (d: Date, timeZone: string) => Number(new Intl.DateTimeFormat('en-US', { timeZone, day: 'numeric' }).format(d));

function isWeekend(date: Date, timeZone: string): boolean {
  const wd = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(date);
  return wd === 'Sat' || wd === 'Sun';
}
