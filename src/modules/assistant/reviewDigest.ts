/**
 * Prints what the daily review reads: the journal's summaries of the
 * conversations since a time, then the activity log's per-message record
 * (problems first). Read-only, and it needs no Discord or API access.
 *
 *   npm run review:digest -- 2026-11-15T06:00:00Z
 *
 * With no time given, it covers the last 24 hours.
 */
import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { ActivityLog } from './activity.js';
import { Journal } from './journal.js';
import { reviewDigest } from './report.js';
import { systemTimeZone } from './time.js';

const arg = process.argv[2];
const since = arg ? new Date(arg) : new Date(Date.now() - 86_400_000);
if (Number.isNaN(since.getTime())) {
  console.error(`Couldn't read "${arg}" as a time. Pass an ISO time like 2026-11-15T06:00:00Z.`);
  process.exit(1);
}
const env = (name: string) => process.env[name]?.trim() || undefined;
const timeZone = env('ASSISTANT_TIMEZONE') ?? systemTimeZone();
const journal = new Journal(env('JOURNAL_FILE') ?? fileURLToPath(new URL('../../../data/journal.json', import.meta.url)));
const activity = new ActivityLog(env('ACTIVITY_DIR') ?? fileURLToPath(new URL('../../../data/activity', import.meta.url)), timeZone);
const events = activity.read(since);
console.log(reviewDigest(journal.entries(), events, timeZone, since));
if (events.length === 0) {
  console.log('\n(The activity log has nothing for this window: either the bot was off, or it predates the log. Read the channels\' history for this stretch instead.)');
}
