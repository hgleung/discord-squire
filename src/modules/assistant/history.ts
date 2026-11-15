import type { ImagePart, Turn, UserPart } from './llm.js';
import { IMAGE_TYPES } from './links.js';
import { toLocalShort } from './time.js';

/** The parts of a Discord message the conversation is built from. */
export interface ChatLine {
  /** The Discord message id; with replyToId, puts each reply back after the message it answers. */
  id?: string;
  replyToId?: string;
  authorId: string;
  content: string;
  createdAt: Date;
  /** Attachment URLs; images among them are shown to the model on lines not yet answered. */
  attachments: { url: string; contentType?: string | null; name: string }[];
  /** Images already downloaded for this line; used in place of the attachment URLs. */
  images?: ImagePart[];
  /** What opening this line's links turned up (where a short link leads, a link that failed). */
  notes?: string[];
}

export interface HistoryOptions {
  botId: string;
  /** Lines from anyone else are left out: the conversation is with one person. */
  userId: string;
  channelName: string;
  timeZone: string;
  /** Lines older than this, relative to the newest, are left out. */
  maxAgeMs: number;
}

/** A reply split over several messages: the later parts follow the first within this long. */
const CONTINUATION_MS = 10_000;

/**
 * Puts each of the bot's replies straight after the message it answers.
 * Replies go out in order of arrival, but a message sent while the bot was
 * busy is answered after a reply that was posted later, so in time order the
 * history can end on the bot (which the API refuses) and pair answers with
 * the wrong questions.
 */
export function threadReplies(lines: ChatLine[], botId: string): ChatLine[] {
  const ids = new Set(lines.map((l) => l.id).filter(Boolean));
  const anchors = new Map<ChatLine, string>();
  let prev: ChatLine | undefined;
  for (const line of lines) {
    if (line.authorId === botId) {
      const prevAnchor = prev && anchors.get(prev);
      if (line.replyToId && ids.has(line.replyToId)) anchors.set(line, line.replyToId);
      else if (prevAnchor && line.createdAt.getTime() - prev!.createdAt.getTime() <= CONTINUATION_MS) anchors.set(line, prevAnchor);
    }
    prev = line;
  }
  const replies = new Map<string, ChatLine[]>();
  for (const [line, anchor] of anchors) replies.set(anchor, [...(replies.get(anchor) ?? []), line]);
  const out: ChatLine[] = [];
  for (const line of lines) {
    if (anchors.has(line)) continue;
    out.push(line);
    if (line.id) out.push(...(replies.get(line.id) ?? []));
  }
  return out;
}

/** The owner's lines after the bot's last reply: the ones a reply is being written for. */
export function unanswered(lines: ChatLine[], opts: Pick<HistoryOptions, 'botId' | 'userId'>): ChatLine[] {
  const threaded = threadReplies(lines, opts.botId);
  const lastBot = threaded.findLastIndex((l) => l.authorId === opts.botId && l.content.trim());
  return threaded.slice(lastBot + 1).filter((l) => l.authorId === opts.userId);
}

/**
 * Turns a channel's recent messages (oldest first) into conversation turns.
 *
 * The channel itself is the memory: nothing is kept between replies, so a
 * restart loses nothing and deleting a message in Discord removes it from what
 * the assistant remembers. Each user turn is stamped with its local time and
 * channel so "in 20 minutes" and "tomorrow" have something to count from.
 */
/** How long after it was sent an answered screenshot is still shown to the model. */
const RECENT_IMAGE_MS = 15 * 60_000;

const hasImages = (l: ChatLine) => (l.images?.length ?? 0) > 0 || l.attachments.some((a) => IMAGE_TYPES.has(a.contentType?.split(';')[0] ?? ''));

/**
 * The owner's last already-answered message with images, if it's recent. It
 * stays visible so "open the link in my screenshot" right after still has the
 * screenshot to read; older ones are only named, to keep the request small.
 */
export function recentScreenshot(lines: ChatLine[], opts: Pick<HistoryOptions, 'botId' | 'userId'>): ChatLine | undefined {
  const threaded = threadReplies(lines, opts.botId);
  const lastBot = threaded.findLastIndex((l) => l.authorId === opts.botId && l.content.trim());
  const newestAt = Math.max(...lines.map((l) => l.createdAt.getTime()));
  const shot = threaded.findLast((l, i) => i <= lastBot && l.authorId === opts.userId && hasImages(l));
  return shot && newestAt - shot.createdAt.getTime() <= RECENT_IMAGE_MS ? shot : undefined;
}

export function buildConversation(lines: ChatLine[], opts: HistoryOptions): Turn[] {
  if (lines.length === 0) return [];
  const newestAt = Math.max(...lines.map((l) => l.createdAt.getTime()));
  const cutoff = newestAt - opts.maxAgeMs;
  const kept = threadReplies(
    lines.filter((l) => l.createdAt.getTime() >= cutoff && (l.authorId === opts.botId || l.authorId === opts.userId)),
    opts.botId,
  );
  // Images are shown for the owner's lines the bot hasn't answered yet; older
  // ones are only named, to keep the request small.
  const lastBot = kept.findLastIndex((l) => l.authorId === opts.botId && l.content.trim());
  const shot = recentScreenshot(kept, opts);

  const turns: { role: 'user' | 'assistant'; blocks: UserPart[] }[] = [];
  for (const [i, line] of kept.entries()) {
    const role = line.authorId === opts.botId ? 'assistant' : 'user';

    const blocks: UserPart[] = [];
    if (role === 'user') {
      const files = line.attachments.map((a) => `\n[attached: ${a.name} ${a.url}]`).join('');
      const stamp = `[${toLocalShort(line.createdAt, opts.timeZone)} · #${opts.channelName}]`;
      const notes = (line.notes ?? []).map((n) => `\n[${n}]`).join('');
      blocks.push({ type: 'text', text: `${stamp} ${line.content}${files}${notes}`.trim() });
      if (i > lastBot || line === shot) {
        const images =
          line.images ??
          line.attachments.flatMap((a): ImagePart[] => {
            const mimeType = a.contentType?.split(';')[0];
            return mimeType && IMAGE_TYPES.has(mimeType) ? [{ type: 'image', url: a.url, mimeType }] : [];
          });
        blocks.unshift(...images);
      }
    } else {
      // Task reports and reminders ping the owner first; drop the mention so
      // they start with their ✅/⏰ marker and read as the task's own post.
      const text = line.content.replace(/^<@!?\d+>\s*/, '');
      if (!text.trim()) continue;
      blocks.push({ type: 'text', text });
    }

    const last = turns.at(-1);
    if (last?.role === role) last.blocks.push(...blocks);
    else turns.push({ role, blocks });
  }

  // The API wants the user to speak first and last.
  while (turns[0]?.role === 'assistant') turns.shift();
  while (turns.at(-1)?.role === 'assistant') turns.pop();
  return turns.map((t): Turn =>
    t.role === 'user'
      ? { role: 'user', content: t.blocks }
      : { role: 'assistant', text: t.blocks.map((b) => (b.type === 'text' ? b.text : '')).join('\n\n') },
  );
}

/**
 * Splits a reply into Discord-sized messages (2000 characters), preferring to
 * break between paragraphs, then lines, then words, and never inside a code
 * fence without closing and reopening it.
 */
export function splitForDiscord(text: string, limit = 2000): string[] {
  const chunks: string[] = [];
  let rest = text.trim();
  let openFence: string | null = null;
  while (rest.length > 0) {
    const prefix = openFence ? `${openFence}\n` : '';
    const room = limit - prefix.length - 4; // leave space to close a fence
    if (prefix.length + rest.length <= limit) {
      chunks.push(prefix + rest);
      break;
    }
    let cut = rest.lastIndexOf('\n\n', room);
    if (cut < room / 2) cut = rest.lastIndexOf('\n', room);
    if (cut < room / 2) cut = rest.lastIndexOf(' ', room);
    if (cut <= 0) cut = room;
    let piece = prefix + rest.slice(0, cut).trimEnd();
    rest = rest.slice(cut).trimStart();

    const fences = piece.match(/^```.*$/gm) ?? [];
    if (fences.length % 2 === 1) {
      openFence = lastOpening(piece);
      piece += '\n```';
    } else {
      openFence = null;
    }
    chunks.push(piece);
  }
  return chunks;
}

/** The opening fence (with its language tag) left unclosed at the end of `text`. */
function lastOpening(text: string): string {
  let open: string | null = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('```')) open = open ? null : line;
  }
  return open ?? '```';
}
