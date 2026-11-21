/**
 * Prints what the daily review reads: the owner's open tickets (messages they
 * flagged with /ticket, whatever their age), the journal's summaries of the
 * conversations since a time, then the activity log's per-message record
 * (problems first), then each factory's eval pass rate, failed checklist
 * items and waiting shadow proposals. Read-only, and it needs no Discord or
 * API access.
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
import { TicketStore, ticketDigest } from './tickets.js';
import { Vault } from '../../vault.js';
import { factoryDigest } from './factoryDigest.js';

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
const tickets = new TicketStore(env('TICKETS_FILE') ?? fileURLToPath(new URL('../../../data/tickets.json', import.meta.url)));
console.log(`${ticketDigest(tickets.list('open'), timeZone)}\n`);
console.log(reviewDigest(journal.entries(), events, timeZone, since));
const vaultRoot = env('OBSIDIAN_VAULT');
if (vaultRoot) console.log(`\n${factoryDigest(new Vault(vaultRoot), since)}`);
if (events.length === 0) {
  console.log('\n(The activity log has nothing for this window: either the bot was off, or it predates the log. Read the channels\' history for this stretch instead.)');
}
