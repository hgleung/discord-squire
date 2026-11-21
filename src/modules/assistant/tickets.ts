import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseDiscordLink } from './links.js';

/**
 * Tickets: the owner points at one of Squire's messages (the "Ticket"
 * message menu, or /ticket with a link) and says what's wrong with it. They
 * land in data/tickets.json, and the nightly review reads the open ones
 * first (npm run review:digest) and closes each in the same run, once it has
 * a PR or a reason to leave it (npm run tickets -- close <id> "<what was
 * done>"), so the open count the owner sees only holds what's still unhandled.
 *
 * The file is read fresh on every call, not held in memory, so the review's
 * close and the running bot's new tickets don't overwrite each other.
 */

export interface Ticket {
  id: string;
  /** When it was filed, ISO. */
  at: string;
  /** What the owner says is wrong. */
  note: string;
  /** The message it's about. */
  messageId: string;
  channelId: string;
  channelName: string;
  link: string;
  /** "Squire", or the owner when they ticket one of their own messages. */
  author: string;
  /** When that message was posted, ISO. */
  postedAt: string;
  /** Its text, cut to MESSAGE_CHARS. */
  text: string;
  /** The message it replied to (usually the owner's ask), when there was one. */
  replyTo?: { messageId: string; text: string };
  status: 'open' | 'closed';
  closedAt?: string;
  /** What the review did about it: a PR link, or why nothing changed. */
  resolution?: string;
}

/** Characters of the ticketed message, and of the message it answered, that are kept. */
export const MESSAGE_CHARS = 3000;
export const REPLY_TO_CHARS = 600;
const MAX_NOTE_CHARS = 1500;
const MAX_TICKETS = 500;

export class TicketStore {
  constructor(private readonly path: string) {}

  get file(): string {
    return this.path;
  }

  list(status?: Ticket['status']): Ticket[] {
    const all = this.read();
    return status ? all.filter((t) => t.status === status) : all;
  }

  add(t: Omit<Ticket, 'id' | 'at' | 'status'>, now = new Date()): Ticket {
    const note = t.note.trim().slice(0, MAX_NOTE_CHARS);
    if (!note) throw new Error('Say what is wrong with the message.');
    const ticket: Ticket = {
      ...t,
      id: randomUUID().slice(0, 6),
      at: now.toISOString(),
      note,
      text: clip(t.text, MESSAGE_CHARS),
      ...(t.replyTo ? { replyTo: { messageId: t.replyTo.messageId, text: clip(t.replyTo.text, REPLY_TO_CHARS) } } : {}),
      status: 'open',
    };
    const all = [...this.read(), ticket];
    // Closed ones go first when the file gets long; open ones are always kept.
    while (all.length > MAX_TICKETS) {
      const i = all.findIndex((x) => x.status === 'closed');
      if (i < 0) break;
      all.splice(i, 1);
    }
    this.write(all);
    return ticket;
  }

  /** Marks a ticket handled, with what was done. Throws for an unknown id. */
  close(id: string, resolution: string, now = new Date()): Ticket {
    const all = this.read();
    const t = all.find((x) => x.id === id);
    if (!t) throw new Error(`No ticket ${id}.`);
    t.status = 'closed';
    t.closedAt = now.toISOString();
    t.resolution = resolution.trim().slice(0, 500) || 'closed';
    this.write(all);
    return t;
  }

  private read(): Ticket[] {
    if (!existsSync(this.path)) return [];
    const data = JSON.parse(readFileSync(this.path, 'utf8')) as { tickets?: Ticket[] };
    return data.tickets ?? [];
  }

  private write(tickets: Ticket[]) {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(`${this.path}.tmp`, JSON.stringify({ tickets }, null, 2));
    renameSync(`${this.path}.tmp`, this.path);
  }
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * Where /ticket's `message` option points: a message link, or a bare ID in
 * the channel the command was used in. Undefined when it's neither.
 */
export function ticketTarget(input: string, channelId: string): { channelId: string; messageId: string } | undefined {
  const s = input.trim();
  if (/^\d{15,22}$/.test(s)) return { channelId, messageId: s };
  const link = parseDiscordLink(s);
  return link?.messageId ? { channelId: link.channelId, messageId: link.messageId } : undefined;
}

/** The open tickets, for the top of the review's digest. */
export function ticketDigest(open: Ticket[], timeZone: string): string {
  const t = (iso: string) => new Intl.DateTimeFormat('en-US', { timeZone, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
  const head = `===== Tickets from the owner: ${open.length} open =====`;
  if (open.length === 0) return `${head}\n(none)`;
  return [
    head,
    'Each is a message the owner flagged, with what they said is wrong. Handle these before anything else, and close each one in this same run as soon as it has a PR (even before the PR is merged) or you decide to leave it: npm run tickets -- close <id> "<PR link, or why not>". Closing only writes data/tickets.json and is safe while the bot runs; a ticket left open keeps counting as open in /tickets and in the "N open" the bot shows when the owner files a new one.',
    ...open.map((x) =>
      [
        `- ${x.id} · filed ${t(x.at)} · #${x.channelName} · ${x.link}`,
        `  Owner's note: ${x.note.replace(/\s*\n\s*/g, ' / ')}`,
        ...(x.replyTo ? [`  In reply to (message ${x.replyTo.messageId}): ${x.replyTo.text.replace(/\s*\n\s*/g, ' / ')}`] : []),
        `  ${x.author}, ${t(x.postedAt)} (message ${x.messageId}): ${x.text.replace(/\s*\n\s*/g, ' / ')}`,
      ].join('\n'),
    ),
  ].join('\n');
}
