/**
 * The review's side of tickets, from the command line.
 *
 *   npm run tickets                         open tickets, in full
 *   npm run tickets -- all                  every ticket, closed ones too
 *   npm run tickets -- close <id> "<note>"  mark one handled: a PR link, or why nothing changed
 */
import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { TicketStore, ticketDigest } from './tickets.js';
import { systemTimeZone } from './time.js';

const env = (name: string) => process.env[name]?.trim() || undefined;
const store = new TicketStore(env('TICKETS_FILE') ?? fileURLToPath(new URL('../../../data/tickets.json', import.meta.url)));
const timeZone = env('ASSISTANT_TIMEZONE') ?? systemTimeZone();
const [cmd, id, ...rest] = process.argv.slice(2);

if (cmd === 'close') {
  if (!id) {
    console.error('Usage: npm run tickets -- close <id> "<what was done>"');
    process.exit(1);
  }
  try {
    const t = store.close(id, rest.join(' '));
    console.log(`Closed ${t.id}: ${t.resolution}`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
} else if (cmd === 'all') {
  for (const t of store.list()) console.log(`${t.id} · ${t.status}${t.resolution ? ` (${t.resolution})` : ''} · #${t.channelName} · ${t.note}`);
} else {
  console.log(ticketDigest(store.list('open'), timeZone));
}
