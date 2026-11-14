/**
 * Offline checks for the Gmail/Calendar tools: draft encoding, body
 * extraction and which tools each mode exposes. No network, no token.
 */
import { buildRawMessage, htmlToText, messageText, type MessagePart } from './gmailTools.js';
import { googleTools, type GoogleAccount } from './google.js';
import { when } from './calendarTools.js';

let failures = 0;
const check = (label: string, ok: boolean, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${label.padEnd(52, '.')} ${ok ? 'OK' : 'FAIL'}  ${detail}`);
};

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
const unraw = (raw: string) => Buffer.from(raw, 'base64url').toString('utf8');

// --- drafts ---
const plain = unraw(buildRawMessage({ to: 'Amy <amy@example.com>', cc: 'bob@example.com', subject: 'Dinner', body: 'Hi\nthere' }));
const [head, body] = plain.split('\r\n\r\n');
check('raw message has To/Cc/Subject', head.includes('To: Amy <amy@example.com>') && head.includes('Cc: bob@example.com') && head.includes('Subject: Dinner'));
check('raw message is UTF-8 text/plain', head.includes('Content-Type: text/plain; charset=UTF-8'));
check('raw body uses CRLF', body === 'Hi\r\nthere', JSON.stringify(body));

const utf = unraw(buildRawMessage({ to: 'amy@example.com', subject: 'Café ☕', body: '' }));
const encoded = utf.match(/^Subject: =\?UTF-8\?B\?([^?]+)\?=/m)?.[1];
check('UTF-8 subject is RFC 2047 encoded', !!encoded && Buffer.from(encoded, 'base64').toString('utf8') === 'Café ☕');

const injected = unraw(buildRawMessage({ to: 'amy@example.com', subject: 'Hi\r\nBcc: evil@example.com', body: 'x' }));
check('CRLF in a header cannot add a header', !/^Bcc:/m.test(injected.split('\r\n\r\n')[0]));

let rejected = false;
try {
  buildRawMessage({ to: 'not an address', subject: 's', body: 'b' });
} catch {
  rejected = true;
}
check('invalid address is rejected', rejected);

// --- bodies ---
const alternative: MessagePart = {
  mimeType: 'multipart/alternative',
  parts: [
    { mimeType: 'text/html', body: { data: b64('<p>HTML version</p>') } },
    { mimeType: 'text/plain', body: { data: b64('Plain version') } },
  ],
};
check('text/plain beats HTML', messageText(alternative).text === 'Plain version', messageText(alternative).text);

const nested: MessagePart = {
  mimeType: 'multipart/mixed',
  parts: [
    { mimeType: 'multipart/alternative', parts: [{ mimeType: 'text/html', body: { data: b64('<div>Your receipt</div>') } }] },
    { mimeType: 'application/pdf', filename: 'receipt.pdf', body: { attachmentId: 'a1', size: 100 } },
  ],
};
const nestedOut = messageText(nested);
check('nested multipart finds HTML body', nestedOut.text === 'Your receipt', nestedOut.text);
check('attachment filename is listed', nestedOut.attachments.join() === 'receipt.pdf', nestedOut.attachments.join());

const html = htmlToText('<style>p{color:red}</style><p>Tom &amp; Jerry&nbsp;&#8212; &lt;hi&gt;</p><br><ul><li>one</li><li>two</li></ul><script>x()</script>');
check('htmlToText strips tags, style, script', !/[<>]\w|color|x\(\)/.test(html.replace('<hi>', '')), JSON.stringify(html));
check('htmlToText decodes entities', html.includes('Tom & Jerry — <hi>'), JSON.stringify(html));
check('htmlToText makes list items lines', /one\n+two/.test(html), JSON.stringify(html));

// --- tool sets ---
const stub = { api: async () => ({}) } as unknown as GoogleAccount; // tool lists never call the API
const names = (readOnly: boolean) => googleTools(stub, 'America/Los_Angeles', { readOnly }).map((t) => t.def.name).sort();
check('readOnly exposes only the read tools', names(true).join() === 'calendar_events,gmail_read,gmail_search', names(true).join());
check('full set has seven tools', names(false).length === 7, names(false).join());

// --- calendar time zones ---
// A Tokyo check-in at 4 PM is midnight in California; it should read as 16:00.
const tokyo = { id: 'e1', start: { dateTime: '2027-06-08T07:00:00Z', timeZone: 'Asia/Tokyo' }, end: { dateTime: '2027-06-10T02:00:00Z', timeZone: 'Asia/Tokyo' } };
const tokyoWhen = when(tokyo, 'America/Los_Angeles');
check('event in another zone shows its own local time', tokyoWhen.includes('8 Jun, 16:00') && tokyoWhen.includes('10 Jun, 11:00') && tokyoWhen.endsWith('Asia/Tokyo time'), tokyoWhen);
const home = when({ id: 'e2', start: { dateTime: '2027-06-08T07:00:00Z', timeZone: 'America/Los_Angeles' }, end: { dateTime: '2027-06-08T08:00:00Z' } }, 'America/Los_Angeles');
check('event in the owner zone has no zone label', home === 'Tue 8 Jun, 00:00 – Tue 8 Jun, 01:00', home);

const sent: Record<string, unknown>[] = [];
const recorder = {
  api: async (_url: string, init?: { body?: Record<string, unknown> }) => {
    if (init?.body) sent.push(init.body);
    return { id: 'new', summary: 'Hotel stay', ...init?.body };
  },
} as unknown as GoogleAccount;
const create = googleTools(recorder, 'America/Los_Angeles', { readOnly: false }).find((t) => t.def.name === 'calendar_create_event')!;
const createArgs = { calendar_id: '', summary: 'Hotel stay', start: '2027-06-08T16:00:00+09:00', end: '2027-06-10T11:00:00+09:00', all_day: false, location: '', description: '' };
const created = String(await create.run({ ...createArgs, time_zone: 'Asia/Tokyo' }));
const sentStart = sent.at(-1)?.start as { timeZone?: string } | undefined;
check('create keeps the zone it is given', sentStart?.timeZone === 'Asia/Tokyo', JSON.stringify(sentStart));
check('create reports times in that zone', created.includes('8 Jun, 16:00'), created);
await create.run({ ...createArgs, time_zone: '' });
check('create defaults to the owner zone', (sent.at(-1)?.start as { timeZone?: string }).timeZone === 'America/Los_Angeles');
let badZone = false;
try {
  await create.run({ ...createArgs, time_zone: 'Japan time' });
} catch {
  badZone = true;
}
check('create rejects a zone that is not IANA', badZone);

if (failures) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nAll Google checks passed');
