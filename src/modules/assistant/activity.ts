import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Usage } from './llm.js';
import { costUsd } from './usage.js';
import { toLocalIso } from './time.js';

/**
 * The activity log: one line per thing the assistant did, kept in
 * data/activity/<local date>.jsonl on this machine only (never in the vault).
 *
 * It's the other half of the journal. The journal says what each
 * conversation was about and what was decided; this says, per message, what
 * was asked in a line, which tools ran, what failed, how long it took and
 * what it cost. So a review can see where a reply went wrong, or where the
 * owner had to ask twice, without re-reading the whole channel, and /usage
 * can add up spending.
 */

export type ActivityKind = 'reply' | 'task' | 'journal' | 'brief' | 'update' | 'style' | 'job';

export interface ActivityEvent {
  /** UTC ISO. */
  at: string;
  kind: ActivityKind;
  /** ok, or what went wrong: error, refused, max_rounds, failed, gave_up, cancelled. */
  outcome: string;
  /** Channel name, without the #. */
  channel?: string;
  /** The Discord message answered, so the review can open it if it needs more. */
  messageId?: string;
  /** reply: the start of what the owner asked (a voice note's transcript). The rest of the conversation is the journal's job. */
  ask?: string;
  /** Set when the message was a voice note. */
  voice?: boolean;
  /** task: its title and id. */
  title?: string;
  taskId?: string;
  /** The factory job this was a run of (recipe, brief, vault-health...), for per-job spend. */
  job?: string;
  error?: string;
  ms?: number;
  /** API calls made. */
  calls?: number;
  /** Custom tools called, in order, with failures as "name: error". */
  tools?: string[];
  usage?: Usage;
  /** Estimated, from list prices. */
  costUsd?: number;
}

/** Characters of the owner's message kept in an event. */
export const ASK_CHARS = 200;
/** Days of activity kept; older files are deleted at startup. */
const KEEP_DAYS = 120;

export class ActivityLog {
  constructor(
    private readonly dir: string,
    private readonly timeZone: string,
  ) {}

  get folder(): string {
    return this.dir;
  }

  /** Appends one event. Never throws: losing a log line must not lose a reply. */
  record(event: Omit<ActivityEvent, 'at' | 'costUsd'> & { at?: string }) {
    const at = event.at ?? new Date().toISOString();
    const full: ActivityEvent = { ...event, at, ...(event.usage ? { costUsd: round(costUsd(event.usage)) } : {}) };
    try {
      mkdirSync(this.dir, { recursive: true });
      appendFileSync(join(this.dir, `${toLocalIso(new Date(at), this.timeZone).slice(0, 10)}.jsonl`), `${JSON.stringify(full)}\n`);
    } catch (err) {
      console.error('[activity] could not write the log:', err);
    }
  }

  /** Events from `since` on (up to `until`), oldest first. */
  read(since: Date, until = new Date()): ActivityEvent[] {
    if (!existsSync(this.dir)) return [];
    // A day either side, since files are named by local date.
    const first = toLocalIso(new Date(since.getTime() - 86_400_000), this.timeZone).slice(0, 10);
    const last = toLocalIso(new Date(until.getTime() + 86_400_000), this.timeZone).slice(0, 10);
    const events: ActivityEvent[] = [];
    for (const name of readdirSync(this.dir).filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).sort()) {
      const day = name.slice(0, 10);
      if (day < first || day > last) continue;
      for (const line of readFileSync(join(this.dir, name), 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line) as ActivityEvent;
          const t = new Date(e.at).getTime();
          if (t >= since.getTime() && t <= until.getTime()) events.push(e);
        } catch {
          // A line cut short by a crash; skip it.
        }
      }
    }
    return events.sort((a, b) => a.at.localeCompare(b.at));
  }

  /** Deletes days older than the retention window. */
  prune(now = new Date()) {
    if (!existsSync(this.dir)) return;
    const cutoff = toLocalIso(new Date(now.getTime() - KEEP_DAYS * 86_400_000), this.timeZone).slice(0, 10);
    for (const name of readdirSync(this.dir)) {
      if (/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name) && name.slice(0, 10) < cutoff) rmSync(join(this.dir, name), { force: true });
    }
  }
}

const round = (n: number) => Math.round(n * 10_000) / 10_000;

/** A reply's or task's running record, filled in as it works. */
export interface Trace {
  /** ok, refused, or max_rounds when the reply ran out of tool rounds. */
  outcome: string;
  calls: number;
  tools: string[];
  usage?: Usage;
}

export const newTrace = (): Trace => ({ outcome: 'ok', calls: 0, tools: [] });

/** Records a turn's tool results on a trace: each tool's name, and the error when it failed. */
export function traceTools(trace: Trace, results: { name: string; content: string; isError?: boolean }[]) {
  for (const r of results) trace.tools.push(r.isError ? `${r.name}: ${r.content.replace(/\s+/g, ' ').slice(0, 160)}` : r.name);
}
