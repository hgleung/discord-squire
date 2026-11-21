import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { unanswered, type ChatLine } from './history.js';
import { toLocalShort } from './time.js';

/**
 * Catching up after downtime. The bot runs on the owner's PC, which sleeps,
 * so messages sent to an assistant channel while it was down never reach
 * onMessage. At startup each channel is read once, and the owner's messages
 * since the bot's last reply that arrived while it was offline are answered
 * together in one reply, apart from the morning brief.
 */

/** How often the bot notes that it's still up. */
export const HEARTBEAT_MS = 60_000;
/**
 * Messages this long before the last heartbeat still count as missed: one
 * sent just before the PC slept may have been mid-answer when it went down.
 */
export const CATCH_UP_GRACE_MS = 10 * 60_000;
/** With no heartbeat on record (the first start), how far back to look. */
export const CATCH_UP_FIRST_RUN_MS = 12 * 3600_000;
/** Most of the owner's messages one catch-up takes in, newest kept. */
export const CATCH_UP_MAX = 25;

/** When the bot was last known to be running, kept in data/last-seen.json. */
export class LastSeen {
  constructor(private readonly path: string) {}

  read(): Date | undefined {
    try {
      if (!existsSync(this.path)) return undefined;
      const at = new Date((JSON.parse(readFileSync(this.path, 'utf8')) as { at?: string }).at ?? '');
      return Number.isNaN(at.getTime()) ? undefined : at;
    } catch {
      return undefined;
    }
  }

  /** Never throws: a missed heartbeat only widens the next catch-up's window. */
  touch(now = new Date()) {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, `${JSON.stringify({ at: now.toISOString() })}\n`);
    } catch (err) {
      console.error('[catch-up] could not record the heartbeat:', err);
    }
  }
}

/** The earliest a missed message can be: a bit before the last heartbeat, or the first-run window. */
export function catchUpSince(lastSeen: Date | undefined, startedAt: Date): Date {
  return lastSeen ? new Date(lastSeen.getTime() - CATCH_UP_GRACE_MS) : new Date(startedAt.getTime() - CATCH_UP_FIRST_RUN_MS);
}

/**
 * The owner's messages that went unanswered because the bot was down: after
 * the bot's last reply in the channel, sent after `since` and before the bot
 * started. Oldest first, at most CATCH_UP_MAX.
 */
export function missedMessages(lines: ChatLine[], opts: { botId: string; userId: string; since: Date; startedAt: Date }): ChatLine[] {
  const since = opts.since.getTime();
  const started = opts.startedAt.getTime();
  return unanswered(lines, opts)
    .filter((l) => l.createdAt.getTime() >= since && l.createdAt.getTime() < started)
    .filter((l) => l.content.trim() || l.attachments.length > 0)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .slice(-CATCH_UP_MAX);
}

/** Shown above the catch-up reply, in code, so it's always there and worded the same. */
export function catchUpHeader(count: number): string {
  return `-# Catching up on ${count === 1 ? 'a message' : `${count} messages`} sent while I was offline`;
}

/** Attached to the newest missed message, so the model knows to cover them all at once. */
export function catchUpNote(count: number, lastSeen: Date | undefined, startedAt: Date, timeZone: string): string {
  const when = lastSeen ? `from about ${toLocalShort(lastSeen, timeZone)} until ${toLocalShort(startedAt, timeZone)}` : `until ${toLocalShort(startedAt, timeZone)}`;
  const which = count === 1 ? 'The owner\'s message above was' : `The owner's last ${count} messages above were`;
  return (
    `Squire system note, not from the owner: Squire was offline ${when}. ${which} sent while it was down and never answered. ` +
    'Address every one of them in this single reply, in the order they were sent, doing whatever each asks (tools included). ' +
    'Keep each part short and label it when there is more than one, e.g. by quoting a few words of the ask. ' +
    'Skip anything a later message already settled or took back. Do not apologise or mention being offline; a line saying so is added for you. ' +
    'This is not the morning brief, so do not add a summary of the day.'
  );
}
