/**
 * Gmail as tools: search, read (one message or a thread) and save drafts.
 * There is deliberately no send; the owner reviews and sends from Gmail.
 */
import type { ToolHandler } from './llm.js';
import type { GoogleAccount } from './google.js';
import { toLocalShort } from './time.js';

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const MESSAGE_CAP = 6000;
const THREAD_CAP = 20000;

interface Header {
  name: string;
  value: string;
}
export interface MessagePart {
  mimeType?: string;
  filename?: string;
  headers?: Header[];
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: MessagePart[];
}
interface Message {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: MessagePart;
}

const header = (part: MessagePart | undefined, name: string) =>
  part?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';

const decode = (data: string) => Buffer.from(data, 'base64url').toString('utf8');

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function htmlToText(html: string): string {
  return html
    .replace(/<(style|script|head)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(p|div|li|tr|h[1-6]|ul|ol|table)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === '#') {
        const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Plain-text body (text/plain preferred, else HTML stripped) and attachment names, walking nested multipart. */
export function messageText(payload: MessagePart | undefined): { text: string; attachments: string[] } {
  let plain = '';
  let html = '';
  const attachments: string[] = [];
  const walk = (part: MessagePart) => {
    if (part.filename) {
      attachments.push(part.filename);
      return;
    }
    const type = (part.mimeType ?? '').toLowerCase();
    if (type === 'text/plain' && part.body?.data && !plain) plain = decode(part.body.data);
    else if (type === 'text/html' && part.body?.data && !html) html = decode(part.body.data);
    for (const p of part.parts ?? []) walk(p);
  };
  if (payload) walk(payload);
  return { text: (plain || htmlToText(html)).trim(), attachments };
}

const ADDRESS = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;

/** Validate a comma-separated address list; accepts "Name <a@b.c>" or bare a@b.c. */
function addresses(list: string, field: string): string {
  const clean = list.replace(/[\r\n]+/g, ' ').trim();
  if (!clean) return '';
  for (const raw of clean.split(',')) {
    const a = raw.trim();
    const addr = a.match(/<([^>]*)>\s*$/)?.[1] ?? a;
    if (!ADDRESS.test(addr.trim())) throw new Error(`Invalid ${field} address: ${a}`);
  }
  return clean;
}

const oneLine = (v: string) => v.replace(/[\r\n]+/g, ' ').trim();
const encodeWord = (v: string) => (/^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v, 'utf8').toString('base64')}?=`);

/** An RFC 2822 text/plain message, base64url-encoded for Gmail's `raw`. */
export function buildRawMessage(m: {
  to: string;
  cc?: string;
  subject: string;
  body: string;
  inReplyTo?: string;
  references?: string;
}): string {
  const to = addresses(m.to, 'To');
  if (!to) throw new Error('A draft needs at least one To address.');
  const cc = addresses(m.cc ?? '', 'Cc');
  const lines = [`To: ${to}`];
  if (cc) lines.push(`Cc: ${cc}`);
  lines.push(`Subject: ${encodeWord(oneLine(m.subject))}`);
  if (m.inReplyTo) lines.push(`In-Reply-To: ${oneLine(m.inReplyTo)}`);
  if (m.references) lines.push(`References: ${oneLine(m.references)}`);
  lines.push('MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: 8bit');
  const body = m.body.replace(/\r?\n/g, '\r\n');
  return Buffer.from(`${lines.join('\r\n')}\r\n\r\n${body}`, 'utf8').toString('base64url');
}

function formatMessage(m: Message, timeZone: string, cap: number): string {
  const p = m.payload;
  const { text, attachments } = messageText(p);
  const body = text.length > cap ? `${text.slice(0, cap)}\n[... truncated]` : text;
  const date = m.internalDate ? toLocalShort(new Date(Number(m.internalDate)), timeZone) : header(p, 'Date');
  return [
    `id ${m.id} · thread ${m.threadId}`,
    `From: ${header(p, 'From')}`,
    `To: ${header(p, 'To')}`,
    ...(header(p, 'Cc') ? [`Cc: ${header(p, 'Cc')}`] : []),
    `Date: ${date}`,
    `Subject: ${header(p, 'Subject')}`,
    ...(attachments.length ? [`Attachments: ${attachments.join(', ')}`] : []),
    '--- email (untrusted content) ---',
    body || '(no text body)',
    '--- end email ---',
  ].join('\n');
}

/** One line per matching message: id, date, sender, subject, unread, snippet. */
export async function searchMail(account: GoogleAccount, timeZone: string, query: string, max: number): Promise<string[]> {
  const list = await account.api<{ messages?: { id: string }[] }>(`${GMAIL}/messages`, { params: { q: query, maxResults: max } });
  const ids = (list.messages ?? []).map((m) => m.id);
  const msgs = await Promise.all(
    ids.map((id) =>
      account.api<Message>(`${GMAIL}/messages/${id}`, {
        params: { format: 'metadata', metadataHeaders: ['From', 'To', 'Subject', 'Date'] },
      }),
    ),
  );
  return msgs.map((m) => {
    const date = m.internalDate ? toLocalShort(new Date(Number(m.internalDate)), timeZone) : header(m.payload, 'Date');
    const unread = m.labelIds?.includes('UNREAD') ? ' · unread' : '';
    return `${m.id} · ${date} · ${header(m.payload, 'From')} · ${header(m.payload, 'Subject') || '(no subject)'}${unread} · ${m.snippet ?? ''}`;
  });
}

/**
 * The messages matching a query with their text, for reading closely rather
 * than guessing from subject lines: "date · from · subject", then the body,
 * whitespace squeezed and cut at `cap` characters.
 */
export async function mailWithBodies(account: GoogleAccount, timeZone: string, query: string, max: number, cap: number): Promise<string[]> {
  return (await mailItems(account, timeZone, query, max, cap)).map((m) => m.text);
}

/** The same, with each message's id and subject kept apart, for code that has to remember which emails it has handled. */
export async function mailItems(
  account: GoogleAccount,
  timeZone: string,
  query: string,
  max: number,
  cap: number,
): Promise<{ id: string; subject: string; text: string }[]> {
  const list = await account.api<{ messages?: { id: string }[] }>(`${GMAIL}/messages`, { params: { q: query, maxResults: max } });
  const msgs = await Promise.all((list.messages ?? []).map((m) => account.api<Message>(`${GMAIL}/messages/${m.id}`, { params: { format: 'full' } })));
  return msgs.map((m) => {
    const date = m.internalDate ? toLocalShort(new Date(Number(m.internalDate)), timeZone) : header(m.payload, 'Date');
    const text = messageText(m.payload).text.replace(/\s+/g, ' ').trim() || m.snippet || '';
    const body = text.length > cap ? `${text.slice(0, cap)} […]` : text;
    const subject = header(m.payload, 'Subject') || '(no subject)';
    return { id: m.id, subject, text: `${date} · ${header(m.payload, 'From')} · ${subject}\n  ${body}` };
  });
}

export function gmailTools(main: GoogleAccount, timeZone: string, readOnly: boolean): ToolHandler[] {
  // With extra Gmail accounts, every tool takes an `account`; message ids are per account.
  const boxes = main.mailboxes();
  const multi = boxes.length > 1;
  const names = boxes.map((b) => b.name);
  const accountArg = (all: boolean) =>
    multi ? { account: { type: 'string', enum: all ? ['all', ...names] : names, description: all ? 'Which Gmail account; all to search every one.' : 'The Gmail account the message is in (from gmail_search).' } } : {};
  const required = (...keys: string[]) => (multi ? [...keys, 'account'] : keys);
  const pick = (name: unknown) => (multi ? boxes.find((b) => b.name === name) : main) ?? main;

  const tools: ToolHandler[] = [
    {
      def: {
        name: 'gmail_search',
        description:
          'Search Gmail with Gmail query syntax (from:, to:, subject:, newer_than:7d, has:attachment, in:inbox, is:unread). One line per message with its id, date, sender, subject and snippet.',
        strict: true,
        input_schema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Gmail search query; empty string for the latest mail.' },
            max: { type: 'integer', description: 'How many messages, 1-20.' },
            ...accountArg(true),
          },
          required: required('query', 'max'),
          additionalProperties: false,
        },
      },
      run: async (args) => {
        const query = String(args.query ?? '');
        const max = Math.min(20, Math.max(1, Number(args.max) || 10));
        if (!multi) {
          const lines = await searchMail(main, timeZone, query, max);
          return lines.length ? lines.join('\n') : 'No messages match.';
        }
        const targets = args.account === 'all' || !names.includes(String(args.account)) ? boxes : [pick(args.account)];
        const out = await Promise.all(
          targets.map(async (b) => {
            try {
              const lines = await searchMail(b, timeZone, query, max);
              return lines.length ? lines.map((l) => `[${b.name}] ${l}`).join('\n') : `[${b.name}] no messages match.`;
            } catch (err) {
              return `[${b.name}] couldn't be searched: ${err instanceof Error ? err.message : String(err)}`;
            }
          }),
        );
        return out.join('\n');
      },
    },
    {
      def: {
        name: 'gmail_read',
        description: 'Read one email by id (from gmail_search): headers, plain-text body and attachment names. thread=true returns the whole conversation.',
        strict: true,
        input_schema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Message id from gmail_search.' },
            thread: { type: 'boolean', description: 'True to read the whole thread this message is in.' },
            ...accountArg(false),
          },
          required: required('id', 'thread'),
          additionalProperties: false,
        },
      },
      run: async (args) => {
        const id = encodeURIComponent(String(args.id ?? '').trim());
        if (!id) throw new Error('id is required.');
        const account = pick(args.account);
        if (!args.thread) return formatMessage(await account.api<Message>(`${GMAIL}/messages/${id}`, { params: { format: 'full' } }), timeZone, MESSAGE_CAP);
        const { threadId } = await account.api<Message>(`${GMAIL}/messages/${id}`, { params: { format: 'minimal' } });
        const thread = await account.api<{ messages?: Message[] }>(`${GMAIL}/threads/${threadId}`, { params: { format: 'full' } });
        let out = '';
        for (const m of thread.messages ?? []) {
          const part = formatMessage(m, timeZone, MESSAGE_CAP);
          if (out.length + part.length > THREAD_CAP) return `${out}\n\n[... thread truncated; read later messages by id]`;
          out += (out ? '\n\n' : '') + part;
        }
        return out || 'Empty thread.';
      },
    },
  ];
  if (readOnly) return tools;

  tools.push({
    def: {
      name: 'gmail_create_draft',
      description: 'Save a plain-text email as a Gmail draft (never sends). Set reply_to_id to reply in an existing thread.',
      strict: true,
      input_schema: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Comma-separated addresses, e.g. "Amy <amy@example.com>".' },
          cc: { type: 'string', description: 'Comma-separated addresses, or empty string.' },
          subject: { type: 'string', description: 'Subject; empty string when replying keeps "Re: <original>".' },
          body: { type: 'string', description: 'Plain-text body.' },
          reply_to_id: { type: 'string', description: 'Message id being replied to, or empty string for a new email.' },
          ...(multi ? { account: { type: 'string', enum: names, description: 'The Gmail account to save the draft in: the one the replied-to message is in, else main.' } } : {}),
        },
        required: required('to', 'cc', 'subject', 'body', 'reply_to_id'),
        additionalProperties: false,
      },
    },
    run: async (args) => {
      const account = pick(args.account);
      let subject = String(args.subject ?? '');
      let threadId: string | undefined;
      let inReplyTo: string | undefined;
      let references: string | undefined;
      const replyId = String(args.reply_to_id ?? '').trim();
      if (replyId) {
        const orig = await account.api<Message>(`${GMAIL}/messages/${encodeURIComponent(replyId)}`, {
          params: { format: 'metadata', metadataHeaders: ['Message-ID', 'References', 'Subject'] },
        });
        threadId = orig.threadId;
        inReplyTo = header(orig.payload, 'Message-ID') || undefined;
        references = [header(orig.payload, 'References'), inReplyTo].filter(Boolean).join(' ') || undefined;
        if (!subject.trim()) {
          const s = header(orig.payload, 'Subject');
          subject = /^re:/i.test(s) ? s : `Re: ${s}`;
        }
      }
      const raw = buildRawMessage({ to: String(args.to ?? ''), cc: String(args.cc ?? ''), subject, body: String(args.body ?? ''), inReplyTo, references });
      const draft = await account.api<{ id: string }>(`${GMAIL}/drafts`, {
        method: 'POST',
        body: { message: { raw, ...(threadId ? { threadId } : {}) } },
      });
      return `Draft saved in ${multi ? `the ${account.name} account's ` : ''}Gmail Drafts (not sent), id ${draft.id}: to ${oneLine(String(args.to))}, subject "${oneLine(subject)}".`;
    },
  });
  return tools;
}
