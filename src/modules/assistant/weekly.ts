import type { GoogleAccount } from './google.js';
import { listEvents, when } from './calendarTools.js';
import type { ReminderStore } from './reminders.js';
import type { ActivityLog } from './activity.js';
import type { TrainingService } from '../training/service.js';
import { addLocalDays, toLocalIso, toLocalShort } from './time.js';
import type { Vault } from '../../vault.js';
import { weeklyFactoryFacts } from './factoryDigest.js';

/**
 * The Sunday weekly review. It goes out in place of that morning's brief, so
 * it keeps the brief's sections for today and adds a look at the week ahead,
 * the training week just ending, what the week's API calls cost, and any
 * memories that recent conversations suggest are out of date.
 */

/** The day the review replaces the brief, by its short English name; undefined turns the review off. */
export const DEFAULT_WEEKLY_DAY = 'Sun';

export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Whether today (in the owner's zone) is the review's day. */
export function isReviewDay(now: Date, timeZone: string, day: string | undefined): boolean {
  if (!day) return false;
  return new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(now) === day;
}

export interface WeeklySources {
  timeZone: string;
  reminders: ReminderStore;
  google?: GoogleAccount;
  training?: TrainingService;
  activity?: ActivityLog;
  /** For the factories' pass rates, waiting shadow results and stuck tasks. */
  vault?: Vault;
}

/** The week's extra facts, added after the brief's own. */
export async function weeklyFacts(src: WeeklySources, now = new Date()): Promise<string> {
  const tz = src.timeZone;
  const today = toLocalIso(now, tz).slice(0, 10);
  // Tomorrow 00:00 local through the 7 days after.
  const tomorrow = new Date(addLocalDays(now, 1, tz));
  const startDay = toLocalIso(tomorrow, tz).slice(0, 10);
  const parts: string[] = ['This is the Sunday weekly review: write it in place of the brief.'];

  if (src.google) {
    try {
      const from = new Date(`${startDay}T00:00:00${toLocalIso(tomorrow, tz).slice(19)}`);
      const to = new Date(from.getTime() + 7 * 86_400_000);
      const events = (await listEvents(src.google, from, to)).filter(({ e }) => (e.start?.date ?? toLocalIso(new Date(e.start?.dateTime ?? 0), tz).slice(0, 10)) > today);
      parts.push(
        events.length
          ? `Calendar for the week ahead (Mon to Sun):\n${events.map(({ e }) => `- ${when(e, tz)}: ${e.summary ?? '(no title)'}${e.location ? ` @ ${e.location}` : ''}`).join('\n')}`
          : 'Calendar for the week ahead: nothing.',
      );
    } catch (err) {
      parts.push(`Calendar for the week: couldn't be read (${err instanceof Error ? err.message : String(err)}).`);
    }
  }

  const weekEnd = new Date(now.getTime() + 8 * 86_400_000);
  const upcoming = src.reminders.list().filter((r) => toLocalIso(new Date(r.due), tz).slice(0, 10) > today && new Date(r.due) < weekEnd);
  if (upcoming.length) parts.push(`Reminders in the week ahead:\n${upcoming.map((r) => `- ${toLocalShort(new Date(r.due), tz)}: ${r.text}`).join('\n')}`);

  if (src.training) {
    try {
      parts.push(`Training, the week just ending (computed by the app; quote numbers as given):\n${src.training.weekFacts()}`);
    } catch (err) {
      parts.push(`Training: couldn't be read (${err instanceof Error ? err.message : String(err)}).`);
    }
  }

  if (src.activity) {
    const events = src.activity.read(new Date(now.getTime() - 7 * 86_400_000), now);
    const total = events.reduce((n, e) => n + (e.costUsd ?? 0), 0);
    const asks = events.filter((e) => e.kind === 'reply').length;
    const failed = events.filter((e) => e.outcome && e.outcome !== 'ok').length;
    parts.push(`Squire's last 7 days: ${asks} replies, about $${total.toFixed(2)} of API calls${failed ? `, ${failed} that ended in an error` : ''}.`);
  }
  if (src.vault) {
    try {
      const factories = weeklyFactoryFacts(src.vault, now);
      if (factories) parts.push(factories);
    } catch (err) {
      parts.push(`Factories: couldn't be read (${err instanceof Error ? err.message : String(err)}).`);
    }
  }
  return parts.join('\n\n');
}

/** Added to the brief's rules on review day. */
export const WEEKLY_RULES = `

Today is the weekly review, which replaces the brief. Keep the brief's sections and rules for today, then add these after them, each only when it has something:
- **Week ahead**: the coming week's events and reminders, grouped by day ("Mon: dentist 3:30 PM"), at most 8 lines; flag a clash or a day that's packed.
- **Training**: one or two lines from the training facts: sessions done, muscles under their target, a lift that moved. Use the numbers as given.
- **Squire**: one line with the week's replies and API cost, as given.
- **Factories**: one line per job from the factories facts: its last eval pass rate and failed items, and any shadow results waiting for approval (say "promote" saves one). Then any task "doing" for more than a day. Leave out a job with nothing new.
- **Memories to check**: at most 3 of the owner's memories that a recent conversation in the journal clearly contradicts or makes out of date, each with why in a few words, so they can tell you to update it. Leave this out unless the journal clearly shows it.
- Start with a one-line look at the week ("Busy week: 3 evenings booked and the Vegas trip Thursday.") before the first section.
- This replaces the 1500-character limit: keep it under 1900 characters.`;
