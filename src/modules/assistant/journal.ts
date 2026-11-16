import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { LLM, ModelOptions, ToolHandler, Usage } from './llm.js';
import { toLocalShort } from './time.js';

/**
 * The assistant's journal: one short summary per past conversation, so a
 * reply days later can pick up where things were left. The channel history
 * only reaches back 30 messages or 12 hours, and memory.ts holds a few
 * durable facts; this sits between them.
 *
 * A conversation counts as finished once its channel has been quiet for a
 * while. It's summarised by the chat model and kept in data/journal.json.
 * Plans with a date ahead ("Japan trip, Apr 8–17 2027") are marked ongoing
 * and stay in every prompt until that date passes; the most recent few
 * summaries go in too, and older ones are found by words in the message
 * being answered or with the recall tool.
 */

export interface JournalEntry {
  id: string;
  channelId: string;
  channelName: string;
  /** First and last message of the conversation, ISO. */
  from: string;
  to: string;
  summary: string;
  /** For a plan still ahead: the last day it matters (YYYY-MM-DD), and what it is. */
  ongoing?: { until: string; topic: string };
}

export interface JournalLine {
  id: string;
  fromOwner: boolean;
  at: Date;
  text: string;
}

interface JournalFile {
  entries: JournalEntry[];
  /** Per channel, the newest message already summarised. */
  cursors: Record<string, string>;
}

/** A gap this long between messages starts a new conversation. */
export const SESSION_GAP_MS = 2 * 3600_000;
/** A conversation is summarised once its channel has been quiet this long. */
export const IDLE_MS = 30 * 60_000;
/** The first run reads this far back. */
export const BACKFILL_MS = 10 * 86_400_000;
const MAX_ENTRIES = 500;
const MAX_SUMMARY_CHARS = 1200;
const MAX_LINE_CHARS = 1500;
const MAX_TRANSCRIPT_CHARS = 40_000;
const RECENT_IN_PROMPT = 5;
const ONGOING_IN_PROMPT = 8;
const RELATED_IN_PROMPT = 3;
const RECALL_HITS = 6;

/** Words too common to say two conversations are related. */
const STOP = new Set(
  'the and for you are but not with this that have from they what when where which will would could should about there their them then than just like also into your our out can get got how its it’s i’m im dont don’t yes yeah okay ok please thanks thank want need make made some any all one two more most very much here now today tomorrow https http www com'.split(' '),
);

export function keywords(text: string): string[] {
  const words = text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w));
  return [...new Set(words)];
}

const day = (iso: string, timeZone: string) =>
  new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso));

export class Journal {
  private data: JournalFile = { entries: [], cursors: {} };

  constructor(private readonly path: string) {
    if (existsSync(path)) this.data = { ...this.data, ...(JSON.parse(readFileSync(path, 'utf8')) as Partial<JournalFile>) };
  }

  get file(): string {
    return this.path;
  }

  entries(): JournalEntry[] {
    return [...this.data.entries];
  }

  cursor(channelId: string): string | undefined {
    return this.data.cursors[channelId];
  }

  /** Records a summarised conversation (or, with no entry, one not worth keeping) and moves the channel's cursor past it. */
  done(channelId: string, lastMessageId: string, entry?: Omit<JournalEntry, 'id'>) {
    if (entry) {
      this.data.entries.push({ id: randomUUID().slice(0, 6), ...entry });
      this.data.entries.sort((a, b) => a.to.localeCompare(b.to));
      if (this.data.entries.length > MAX_ENTRIES) this.data.entries = this.data.entries.slice(-MAX_ENTRIES);
    }
    this.data.cursors[channelId] = lastMessageId;
    this.save();
  }

  /** Entries that mention the words, best match first. */
  search(text: string, limit = RECALL_HITS, exclude = new Set<string>()): JournalEntry[] {
    const words = keywords(text);
    if (words.length === 0) return [];
    return this.data.entries
      .filter((e) => !exclude.has(e.id))
      .map((e) => {
        const hay = `${e.channelName} ${e.ongoing?.topic ?? ''} ${e.summary}`.toLowerCase();
        return { e, score: words.filter((w) => hay.includes(w)).length };
      })
      .filter((h) => h.score > 0)
      .sort((a, b) => b.score - a.score || b.e.to.localeCompare(a.e.to))
      .slice(0, limit)
      .map((h) => h.e);
  }

  /** Plans still ahead, and the latest conversations: the fixed part, so it only changes when an entry is added. */
  standing(now: Date): JournalEntry[] {
    const today = now.toISOString().slice(0, 10);
    const ongoing = this.data.entries.filter((e) => e.ongoing && e.ongoing.until >= today).slice(-ONGOING_IN_PROMPT);
    const recent = this.data.entries.filter((e) => !ongoing.includes(e)).slice(-RECENT_IN_PROMPT);
    return [...ongoing, ...recent].sort((a, b) => a.to.localeCompare(b.to));
  }

  /** The system prompt block: plans still ahead and the latest conversations. */
  prompt(timeZone: string, now = new Date()): string {
    const shown = this.standing(now);
    if (shown.length === 0) return '';
    return `\n\nYour journal of earlier conversations (oldest first; recall finds older ones):\n${shown.map((e) => format(e, timeZone)).join('\n')}`;
  }

  /** Older conversations that share words with the message being answered, as a note for that turn. */
  related(text: string, timeZone: string, now = new Date()): string {
    const skip = new Set(this.standing(now).map((e) => e.id));
    const hits = this.search(text, RELATED_IN_PROMPT, skip);
    return hits.length ? `[Older conversations that may be related, from your journal:\n${hits.map((e) => format(e, timeZone)).join('\n')}]` : '';
  }

  private save() {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.path);
  }
}

function format(e: JournalEntry, timeZone: string): string {
  const ongoing = e.ongoing ? ` (ongoing until ${e.ongoing.until}: ${e.ongoing.topic})` : '';
  return `- ${day(e.from, timeZone)} · #${e.channelName}${ongoing}: ${e.summary.replace(/\s*\n\s*/g, ' ')}`;
}

/** Splits a channel's messages, oldest first, into conversations at long gaps. */
export function splitSessions(lines: JournalLine[], gapMs = SESSION_GAP_MS): JournalLine[][] {
  const sessions: JournalLine[][] = [];
  for (const line of lines) {
    const last = sessions.at(-1);
    if (last && line.at.getTime() - last.at(-1)!.at.getTime() < gapMs) last.push(line);
    else sessions.push([line]);
  }
  return sessions;
}

const SUMMARY_SYSTEM = `You keep a journal for Squire, a personal assistant, so it can pick conversations back up days later without asking its owner to repeat themselves. You get one finished conversation between the owner and Squire. Write its journal entry.

- Plain text, under 900 characters, no headings or bullets. Start with a few words naming the topic, then a colon.
- Keep the specifics a later conversation would need: dates, places, names, bookings and confirmation numbers, prices, decisions made, preferences stated, and where things were saved (note paths, lists, calendar events, reminders).
- Say what was left open: questions not answered yet, things still to book or decide, anything Squire offered to do.
- Only what the conversation shows. Don't add advice or guesses.
- If the plan has a date still ahead (a trip, an event, a deadline), end with one last line exactly like: ONGOING 2027-06-12: Japan trip (Tokyo, Osaka)
  using the last day it matters. Leave that line out otherwise.
- If there's nothing worth remembering (a greeting, a one-word test), answer only: SKIP`;

/** Turns one conversation into a journal entry; undefined when it isn't worth keeping. */
export async function summarize(
  llm: LLM,
  model: ModelOptions,
  channelName: string,
  lines: JournalLine[],
  timeZone: string,
  onUsage?: (usage: Usage) => void,
): Promise<Pick<JournalEntry, 'summary' | 'ongoing'> | undefined> {
  let transcript = lines
    .map((l) => `[${toLocalShort(l.at, timeZone)}] ${l.fromOwner ? 'Owner' : 'Squire'}: ${l.text.length > MAX_LINE_CHARS ? `${l.text.slice(0, MAX_LINE_CHARS)}…` : l.text}`)
    .join('\n');
  if (transcript.length > MAX_TRANSCRIPT_CHARS) transcript = `…${transcript.slice(-MAX_TRANSCRIPT_CHARS)}`;
  const gen = await llm.generate(model, {
    system: SUMMARY_SYSTEM,
    tools: [],
    turns: [{ role: 'user', content: [{ type: 'text', text: `Conversation in #${channelName}:\n\n${transcript}` }] }],
    web: { maxUses: 0 },
  });
  if (gen.usage) onUsage?.(gen.usage);
  return parseSummary(gen.text);
}

export function parseSummary(text: string): Pick<JournalEntry, 'summary' | 'ongoing'> | undefined {
  const clean = text.trim();
  if (!clean || /^SKIP\b/.test(clean)) return undefined;
  const match = /\n?\s*ONGOING (\d{4}-\d{2}-\d{2}):\s*(.+?)\s*$/.exec(clean);
  const summary = (match ? clean.slice(0, match.index) : clean).trim().slice(0, MAX_SUMMARY_CHARS);
  if (!summary) return undefined;
  return match ? { summary, ongoing: { until: match[1]!, topic: match[2]!.slice(0, 120) } } : { summary };
}

export const JOURNAL_PROMPT = `
Picking up where you left off:
- Your journal (at the end of this prompt) summarises earlier conversations, including plans still ahead. Treat it as what you already know: when a message touches one of them, connect it without being asked. A restaurant in Tokyo while a Japan trip is ongoing belongs to that trip; say so and use what you know about it (dates, where they're staying).
- When something sounds familiar but isn't in front of you, use recall, then search_notes and the calendar, before asking. Never ask your owner for something they already told you; ask only when all of those come up empty.
- The journal is a summary. For exact details (a confirmation number, a price) read the note or email it points to rather than quoting the summary.`;

export function journalTools(journal: Journal, timeZone: string): ToolHandler[] {
  return [
    {
      def: {
        name: 'recall',
        description: 'Search your journal of past conversations with the owner, in every channel, by words ("Japan", "Osaka hotel", "Riven"). Newest matches first among equals.',
        // Not strict: it only reads, and strict slots go to tools that change things.
        strict: false,
        input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      },
      run(args) {
        const hits = journal.search(String(args.query ?? ''));
        return hits.length ? hits.map((e) => format(e, timeZone)).join('\n') : `Nothing in the journal about "${args.query}".`;
      },
    },
  ];
}
