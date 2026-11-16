/**
 * Offline checks for the assistant: time zone math, reminder scheduling, how
 * a channel's history becomes a conversation, how that conversation is sent to
 * the API, background tasks, memory, notes, and message splitting. No
 * network, no Discord, no API key.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReminderStore, nextOccurrence } from './reminders.js';
import { addLocalDays, toLocalIso } from './time.js';
import { buildConversation, splitForDiscord, threadReplies, unanswered, type ChatLine } from './history.js';
import { expandShortLink, fetchImage, fetchPage, findUrls, isDiscordCdn, isPrivateAddress, isShortLink, MAX_IMAGE_BYTES, parseDiscordLink, recipeFromHtml, resizedDiscordUrl, type Fetcher } from './links.js';
import { linkTools } from './linkTools.js';
import { messageAttachments, messageText } from './discordLinks.js';
import { captionText, describeVideo, pickCaptions, readVideo, tiktokSlides, instagramSlides, videoTools } from './video.js';
import { cleanTranscript } from './transcribe.js';
import { TaskRunner, TaskStore } from './tasks.js';
import { profilePrompt, Sources, type Generation, type GenerateRequest, type LLM, type ModelOptions, type ToolCall, type Turn } from './llm.js';
import Anthropic from '@anthropic-ai/sdk';
import { fromMessage, grammarTooLarge, limitStrict, MAX_STRICT_SCHEMA_CHARS, MAX_STRICT_TOOLS, toMessages, webTools } from './anthropic.js';
import { MemoryStore } from './memory.js';
import { notesTools } from './notes.js';
import { ReadLog, pageKey } from './readLog.js';
import { trainingTools } from './trainingTools.js';
import { TrainingService } from '../training/service.js';
import { PlanStore } from '../training/store.js';
import { Vault } from '../../vault.js';
import { isOpenAt, mapsLink, parseListResponse, SavedPlaces, todaysHours, type PlaceDetails } from './places.js';
import { placesTools } from './placesTools.js';
import { Journal, journalTools, parseSummary, splitSessions, summarize, type JournalLine } from './journal.js';
import { Agent, withRelated } from './agent.js';
import { ActivityLog, newTrace, traceTools } from './activity.js';
import { addUsage, costUsd, dollars, noUsage } from './usage.js';
import { reviewDigest, usageSummary } from './report.js';
import { BriefState, briefChannel, briefFacts, dropMissingNotes } from './brief.js';
import { rememberTranscript, voiceLine } from './voice.js';

let failures = 0;
const check = (label: string, ok: boolean, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${label.padEnd(52, '.')} ${ok ? 'OK' : 'FAIL'}  ${detail}`);
};

const LA = 'America/Los_Angeles';

// --- time ---
const nov12 = new Date('2026-11-12T21:51:00Z');
check('local ISO carries the PST offset', toLocalIso(nov12, LA) === '2026-11-12T13:51:00-08:00', toLocalIso(nov12, LA));
const summer = new Date('2026-07-01T15:00:00Z');
check('local ISO carries the PDT offset', toLocalIso(summer, LA) === '2026-07-01T08:00:00-07:00', toLocalIso(summer, LA));
// DST ends 2026-11-01 in LA: 8am the day before is 15:00Z, 8am the day after is 16:00Z.
const beforeDst = new Date('2026-10-31T15:00:00Z');
const after = addLocalDays(beforeDst, 1, LA);
check('daily step keeps 8am across DST end', toLocalIso(after, LA) === '2026-11-01T08:00:00-08:00', toLocalIso(after, LA));

// --- recurrence ---
const fri = new Date('2026-11-13T16:00:00Z'); // Fri 08:00 PST
const nextWeekday = nextOccurrence(fri, 'weekdays', LA, fri);
check('weekdays skips the weekend', toLocalIso(nextWeekday, LA) === '2026-11-16T08:00:00-08:00', toLocalIso(nextWeekday, LA));
const jan31 = new Date('2027-01-31T17:00:00Z'); // 09:00 PST
const feb = nextOccurrence(jan31, 'monthly', LA, jan31);
check('monthly on the 31st clamps to Feb 28', toLocalIso(feb, LA) === '2027-02-28T09:00:00-08:00', toLocalIso(feb, LA));
const missed = nextOccurrence(new Date('2026-11-01T16:00:00Z'), 'daily', LA, nov12);
check('missed daily jumps to the next future slot', toLocalIso(missed, LA) === '2026-11-13T08:00:00-08:00', toLocalIso(missed, LA));

// --- store ---
const dir = mkdtempSync(join(tmpdir(), 'squire-reminders-'));
try {
  const file = join(dir, 'nested', 'reminders.json');
  const store = new ReminderStore(file, LA);
  const once = store.add({ text: 'Call mum', due: new Date('2026-11-12T22:00:00Z'), repeat: 'none', channelId: 'c1' }, nov12);
  const daily = store.add({ text: 'Creatine', due: new Date('2026-11-12T16:00:00Z'), repeat: 'daily', channelId: 'c2' }, nov12);
  check('nothing due before its time', store.takeDue(new Date('2026-11-12T15:59:00Z')).length === 0);

  const fired = store.takeDue(new Date('2026-11-12T22:00:30Z'));
  check('both fire once due', fired.length === 2, fired.map((r) => r.text).join(', '));
  const left = store.list();
  check('one-off is gone, daily stays', left.length === 1 && left[0]!.id === daily.id);
  check('daily moved to tomorrow 8am', toLocalIso(new Date(left[0]!.due), LA) === '2026-11-13T08:00:00-08:00', left[0]!.due);

  const reloaded = new ReminderStore(file, LA);
  check('survives a restart', reloaded.list().length === 1 && reloaded.list()[0]!.text === 'Creatine');
  check('cancel removes it', reloaded.cancel(daily.id)?.id === daily.id && reloaded.list().length === 0);
  check('cancel of an unknown id is undefined', reloaded.cancel(once.id) === undefined);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// --- conversation ---
const at = (min: number) => new Date(nov12.getTime() + min * 60_000);
const line = (authorId: string, content: string, min: number, attachments: ChatLine['attachments'] = []): ChatLine => ({
  authorId, content, createdAt: at(min), attachments,
});
const opts = { botId: 'bot', userId: 'me', channelName: 'gym', timeZone: LA, maxAgeMs: 12 * 3600_000 };
const convo = buildConversation(
  [
    line('bot', '⏰ old reminder', -800), // too old
    line('bot', 'leading bot line', -5), // can't open a conversation
    line('me', 'what should I hit today?', 0),
    line('someone-else', 'ignore me', 1),
    line('bot', 'Legs.', 2),
    line('me', 'ok', 3),
    line('me', 'what about this', 4, [{ url: 'https://cdn/x.png', contentType: 'image/png', name: 'x.png' }]),
  ],
  opts,
);
check('starts with the user', convo[0]?.role === 'user');
check('roles alternate, others dropped', convo.map((m) => m.role).join(',') === 'user,assistant,user', convo.map((m) => m.role).join(','));
const firstText = (convo[0] as Extract<Turn, { role: 'user' }>).content[0];
check('user turns carry a local stamp and channel', firstText?.type === 'text' && firstText.text.startsWith('[Thu 12 Nov, 13:51 · #gym]'), JSON.stringify(firstText));
const lastParts = (convo[2] as Extract<Turn, { role: 'user' }>).content;
check('newest image sits before its line, lines merged', lastParts.map((b) => b.type).join(',') === 'text,image,text', lastParts.map((b) => b.type).join(','));

// --- a message answered after a later reply was posted ---
{
  const l = (id: string, authorId: string, content: string, sec: number, replyToId?: string): ChatLine => ({
    id, replyToId, authorId, content, createdAt: new Date(nov12.getTime() + sec * 1000), attachments: [],
  });
  // Seen in #recipes: two messages a second apart; the reply to the first
  // lands after the second, then the second is answered.
  const lines = [l('1', 'me', 'radish recipe', 0), l('2', 'me', 'https://shaking.beef', 1), l('3', 'bot', 'Saved the radish.', 7, '1')];
  const turns = buildConversation(lines, opts);
  check('history never ends on the bot', turns.at(-1)?.role === 'user', turns.map((t) => t.role).join(','));
  const lastText = turns.at(-1)?.role === 'user' ? JSON.stringify((turns.at(-1) as Extract<Turn, { role: 'user' }>).content) : '';
  check('a late reply sits after the message it answers', turns.map((t) => t.role).join(',') === 'user,assistant,user' && lastText.includes('shaking.beef'), lastText);
  const split = threadReplies([...lines, l('4', 'bot', 'part two of the radish reply', 8)], 'bot');
  check('later parts of a split reply move with it', split.map((x) => x.id).join(',') === '1,3,4,2', split.map((x) => x.id).join(','));
  check('unanswered lines are the ones after the last reply', unanswered(lines, { botId: 'bot', userId: 'me' }).map((x) => x.id).join(',') === '2');
  const reminderLast = buildConversation([l('1', 'me', 'hi', 0), l('2', 'bot', 'hey', 1, '1'), l('3', 'bot', '⏰ stretch', 60)], opts);
  check('a trailing reminder is dropped, not sent last', reminderLast.at(-1)?.role === 'user');
  // Seen in #recipes, Nov 14: "there's a link in my screenshot, open that" a
  // minute after the screenshot, which the model could no longer see.
  const shot = { url: 'https://cdn/s.jpg', contentType: 'image/jpeg', name: 's.jpg' };
  const imageCount = (t: Turn[]) => t.flatMap((x) => (x.role === 'user' ? x.content : [])).filter((b) => b.type === 'image').length;
  const recentShot = buildConversation([{ ...l('1', 'me', '', 0), attachments: [shot] }, l('2', 'bot', 'Got it.', 30, '1'), l('3', 'me', 'open the link in it', 90)], opts);
  check('a screenshot from a minute ago is still shown', imageCount(recentShot) === 1, String(imageCount(recentShot)));
  const oldShot = buildConversation([{ ...l('1', 'me', '', 0), attachments: [shot] }, l('2', 'bot', 'Got it.', 30, '1'), l('3', 'me', 'thanks', 3600)], opts);
  check('an answered screenshot from an hour ago is only named', imageCount(oldShot) === 0, String(imageCount(oldShot)));
  // Seen in #recipes, Nov 14: a pinged task report read as the bot's own
  // unsourced reply, and the assistant disowned the task's work.
  const pinged = buildConversation([l('1', 'me', 'find amounts', 0), l('2', 'bot', '<@123> ✅ **Kai Jeow amounts** — done', 60), l('3', 'me', 'save it', 70)], opts);
  const pingedText = pinged[1]?.role === 'assistant' ? pinged[1].text : '';
  check('a pinged task report starts with its marker', pingedText.startsWith('✅'), pingedText);
  const withNotes = buildConversation(
    [{ ...l('1', 'me', 'look https://t.co/x', 0), notes: ['https://t.co/x leads to https://pastebin.com/y'], images: [{ type: 'image', url: 'u', mimeType: 'image/png', data: 'AAAA' }] }],
    opts,
  );
  const parts0 = (withNotes[0] as Extract<Turn, { role: 'user' }>).content;
  check('link notes and downloaded images reach the model', parts0[0]?.type === 'image' && parts0[1]?.type === 'text' && parts0[1].text.includes('leads to https://pastebin.com/y'));
}

// --- the conversation as the Messages API sees it ---
{
  const call: ToolCall = { id: 'c1', name: 'create_reminder', input: { text: 'x' } };
  const turns: Turn[] = [
    ...convo,
    { role: 'assistant', text: 'On it.', calls: [call], native: [{ type: 'text', text: 'On it.' }, { type: 'tool_use', id: 'c1', name: 'create_reminder', input: { text: 'x' } }] },
    { role: 'tool', results: [{ callId: 'c1', name: 'create_reminder', content: 'Created.' }], note: 'The deadline has passed.' },
  ];
  const messages = toMessages(turns);
  check('anthropic: roles alternate', messages.map((m) => m.role).join(',') === 'user,assistant,user,assistant,user', messages.map((m) => m.role).join(','));
  const last = messages.at(-1)!.content as { type: string; tool_use_id?: string }[];
  check('anthropic: tool results and the note share one user turn', last.map((b) => b.type).join(',') === 'tool_result,text' && last[0]!.tool_use_id === 'c1');
  const image = (messages[2]!.content as { type: string; source?: { url?: string } }[])[1];
  check('anthropic: images go by URL', image?.type === 'image' && image.source?.url === 'https://cdn/x.png', JSON.stringify(image));
  const inline = toMessages([
    { role: 'user', content: [{ type: 'image', url: 'https://cdn/y.jpg', mimeType: 'image/jpeg', data: 'QUJD' }, { type: 'text', text: 'this' }] },
    { role: 'assistant', text: '', calls: [{ id: 'r1', name: 'read_discord_messages', input: {} }] },
    { role: 'tool', results: [{ callId: 'r1', name: 'read_discord_messages', content: 'two messages', images: [{ type: 'image', url: 'z', mimeType: 'image/png', data: 'WFla' }] }] },
  ]);
  const b64 = (inline[0]!.content as { source?: { type: string; data?: string } }[])[0];
  check('anthropic: downloaded images go inline as base64', b64?.source?.type === 'base64' && b64.source.data === 'QUJD', JSON.stringify(b64));
  const tr = (inline[2]!.content as { content?: { type: string }[] }[])[0];
  check('anthropic: tool results can carry images', Array.isArray(tr?.content) && tr.content.map((c) => c.type).join(',') === 'text,image', JSON.stringify(tr));

  const gen = fromMessage({
    stop_reason: 'tool_use',
    content: [
      { type: 'text', text: 'Booked.', citations: [{ type: 'web_search_result_location', url: 'https://a.example', title: 'A', cited_text: '', encrypted_index: '' }] },
      { type: 'tool_use', id: 't9', name: 'remember', input: { text: 'y' }, caller: { type: 'direct' } },
    ],
  } as never);
  check('anthropic: reply parsed into text, calls, sources', gen.stop === 'tool_use' && gen.calls[0]?.id === 't9' && gen.sources.pages.get('https://a.example') === 'A');

  const fetched = fromMessage({
    stop_reason: 'end_turn',
    content: [
      { type: 'web_fetch_tool_result', tool_use_id: 'f1', content: { type: 'web_fetch_result', url: 'https://cook.example/curry', retrieved_at: null, content: { type: 'document', title: 'Curry', source: { type: 'text', media_type: 'text/plain', data: '' } } } },
      { type: 'web_fetch_tool_result', tool_use_id: 'f2', content: { type: 'web_fetch_tool_result_error', error_code: 'url_not_accessible' } },
      { type: 'text', text: 'Read it.' },
    ],
  } as never);
  check('anthropic: pages web_fetch opened are tracked, failed ones not', fetched.sources.opened.size === 1 && fetched.sources.opened.get('https://cook.example/curry') === 'Curry', [...fetched.sources.opened.keys()].join(','));
}


// --- splitting ---
check('short text is one message', splitForDiscord('hello').length === 1);
const long = Array.from({ length: 60 }, (_, i) => `Paragraph ${i} ${'word '.repeat(10)}`).join('\n\n');
const parts = splitForDiscord(long);
check('long text splits under 2000', parts.length > 1 && parts.every((p) => p.length <= 2000), `${parts.length} parts`);
const code = '```ts\n' + Array.from({ length: 200 }, (_, i) => `const v${i} = ${i};`).join('\n') + '\n```';
const codeParts = splitForDiscord(code);
check(
  'split code fences are closed and reopened',
  codeParts.length > 1 && codeParts.every((p) => (p.match(/^```/gm) ?? []).length % 2 === 0) && codeParts[1]!.startsWith('```ts'),
  `${codeParts.length} parts`,
);

// --- background tasks, with a scripted stand-in for the API ---
{
  const tdir = mkdtempSync(join(tmpdir(), 'squire-tasks-'));
  const settle = () => new Promise((r) => setTimeout(r, 30));
  try {
    const later = new Date(Date.now() + 2 * 3600_000);
    const step = (text: string, calls: ToolCall[]): Generation => ({
      stop: calls.length ? 'tool_use' : 'done',
      text,
      calls,
      sources: new Sources(),
      turn: { role: 'assistant', text, calls },
    });
    const script = [
      step('Checking.', [
        { id: 't1', name: 'post_update', input: { text: 'Fares start at $912.' } },
        { id: 't2', name: 'wait_until', input: { at: later.toISOString(), reason: 'check fares again' } },
      ]),
      step('', [{ id: 't3', name: 'finish_task', input: { outcome: 'done', report: 'Fare dropped to **$780** on JAL.' } }]),
    ];
    const seen: Turn[][] = [];
    const models: string[] = [];
    const offered: string[][] = [];
    const systems: string[] = [];
    const posts: { channelId: string; content: string; ping: boolean }[] = [];
    const tfile = join(tdir, 'tasks.json');
    const rstore = new ReminderStore(join(tdir, 'r.json'), LA);
    const vault = new Vault(tdir);
    const fake: LLM = {
      retryable: () => false,
      async generate(model: ModelOptions, req: GenerateRequest) {
        seen.push(structuredClone(req.turns));
        models.push(model.model);
        offered.push(req.tools?.map((t) => t.name) ?? []);
        systems.push(req.system ?? '');
        const next = script.shift();
        if (!next) throw new Error('script ran out');
        return next;
      },
    };
    const make = () =>
      new TaskRunner(new TaskStore(tfile), {
        llm: fake,
        model: 'big-model',
        fastModel: 'small-model',
        effort: 'low',
        timeZone: LA,
        reminders: rstore,
        vault,
      });
    let runner = make();
    runner.setPoster(async (channelId, content, ping) => void posts.push({ channelId, content, ping }));

    let threw = '';
    try {
      runner.start({ title: 'x', goal: 'y', doneWhen: 'z', deadline: new Date(Date.now() + 40 * 86_400_000), channelId: 'c', channelName: 'travel' });
    } catch (err) {
      threw = (err as Error).message;
    }
    check('task deadline over 30 days is refused', threw.includes('30 days'), threw);

    const task = runner.start({
      title: 'Tokyo fares',
      goal: 'Watch SEA→HND fares for 3–10 March',
      doneWhen: 'A round trip under $800, or the deadline passes',
      deadline: new Date(Date.now() + 86_400_000),
      channelId: 'travel-id',
      channelName: 'travel',
    });
    await settle();
    const first = runner.list().find((t) => t.id === task.id)!;
    check('task waits after wait_until', first.status === 'waiting' && first.wakeAt === later.toISOString(), first.status);
    check('progress update posted without a ping', posts.length === 1 && posts[0]!.content.includes('$912') && !posts[0]!.ping);
    const brief = JSON.stringify(seen[0]?.[0] ?? '');
    const workerTools = offered[0] ?? [];
    check(
      'worker can read and write notes but not move or delete them',
      ['save_note', 'read_note', 'search_notes', 'list_notes'].every((n) => workerTools.includes(n)) &&
        !workerTools.includes('delete_note') &&
        !workerTools.includes('move_note'),
      workerTools.join(', '),
    );
    check('worker is told its report is posted and how to scale recipes', systems[0]!.includes('posted in the channel') && systems[0]!.includes('target ÷ source servings'));
    check('worker brief carries goal, end point and deadline', brief.includes('SEA→HND') && brief.includes('Done when') && brief.includes('Deadline'));

    // A restart while it waits: a fresh runner reads the same file.
    runner = make();
    runner.setPoster(async (channelId, content, ping) => void posts.push({ channelId, content, ping }));
    check('nothing runs before the wake time', runner.tick().length === 0);
    await Promise.all(runner.tick(new Date(later.getTime() + 1000)));
    const resumed = seen[1]?.at(-1);
    const answered = resumed?.role === 'tool' ? resumed.results.map((r) => r.callId).join(',') : '';
    check('resume answers both pending calls', answered === 't1,t2', answered);
    const done = runner.list().find((t) => t.id === task.id)!;
    check('task ends done after finish_task', done.status === 'done' && done.messages.length === 0, done.status);
    const final = posts.at(-1);
    check('final report posted with a ping', !!final && final.ping && final.content.includes('$780') && final.channelId === 'travel-id');
    const notes = vault.list('Squire/Tasks');
    check(
      'final report saved as a note and linked',
      notes.length === 1 && notes[0]!.endsWith('Tokyo fares.md') && vault.read(notes[0]!)!.includes('$780') && final!.content.includes(`Saved to ${notes[0]}`),
      notes.join(', '),
    );

    const doomed = runner.start({ title: 'Doomed', goal: 'g', doneWhen: 'd', deadline: new Date(Date.now() + 3600_000), channelId: 'c', channelName: 'misc' });
    runner.cancel(doomed.id);
    await settle();
    check('capable tier runs on the task model', models[0] === 'big-model', models[0]);
    runner.start({ title: 'Quick', goal: 'g', doneWhen: 'd', deadline: new Date(Date.now() + 3600_000), tier: 'fast', channelId: 'c', channelName: 'misc' });
    await settle();
    check('fast tier runs on the chat model', models.at(-1) === 'small-model', models.at(-1));
    check('a failed task saves no note', vault.list('Squire/Tasks').length === 1);
    check('cancelled task stays cancelled', runner.list().find((t) => t.id === doomed.id)?.status === 'cancelled');
  } finally {
    rmSync(tdir, { recursive: true, force: true });
  }
}

// --- owner profile ---
const home = { city: 'Springfield', region: 'Oregon', country: 'US', timezone: LA };
const about = profilePrompt({ location: home, about: 'Works downtown.' });
check('profile names home and the free-text line', about.includes('Springfield, Oregon, US') && about.includes('Works downtown.'));
check('no profile adds nothing', profilePrompt({}) === '' && profilePrompt(undefined) === '');
const search = webTools('claude-haiku-5-5', 5, home)[0] as { user_location?: { city?: string; type?: string } };
check('web search is localised to home', search.user_location?.city === 'Springfield' && search.user_location.type === 'approximate');

// --- strict tool cap ---
{
  const tool = (name: string, props = 1) => ({
    name, description: '', strict: true,
    input_schema: { type: 'object' as const, properties: Object.fromEntries(Array.from({ length: props }, (_, i) => [`p${i}`, {}])) },
  });
  const many = [tool('list_reminders', 0), tool('places_lists', 0), tool('gmail_search'), tool('calendar_events'),
    ...Array.from({ length: 25 }, (_, i) => tool(`write_${i}`))];
  const out = limitStrict(many);
  check('at most 20 tools stay strict', out.filter((t) => t.strict).length === MAX_STRICT_TOOLS);
  check('no-input and read tools lose strict first', !out.slice(0, 4).some((t) => t.strict) && out[4]!.strict === true);
  const few = [tool('a'), tool('b')];
  check('under the cap nothing changes', limitStrict(few) === few);
  // Too big to compile together, though under the count: the size budget decides.
  const big = (name: string) => ({ ...tool(name), input_schema: { ...tool(name).input_schema, properties: { p: { description: 'x'.repeat(1400) } } } });
  const sized = limitStrict([big('save_a'), big('save_b'), big('save_c'), big('save_d'), big('save_e'), tool('save_small')]);
  const kept = sized.filter((t) => t.strict);
  const keptSize = kept.reduce((n, t) => n + JSON.stringify(t.input_schema).length, 0);
  check('strict schemas stay under the size budget', keptSize <= MAX_STRICT_SCHEMA_CHARS && kept.length === 5 && kept.at(-1)!.name === 'save_small', `${kept.length} kept, ${keptSize} chars`);
  check('the grammar error is recognised', grammarTooLarge(new Anthropic.BadRequestError(400, { type: 'error', error: { type: 'invalid_request_error', message: 'The compiled grammar is too large, which would cause performance issues.' } }, 'The compiled grammar is too large, which would cause performance issues.', new Headers())) && !grammarTooLarge(new Error('grammar is too large')));
}

// --- memory ---
{
  const mdir = mkdtempSync(join(tmpdir(), 'squire-memory-'));
  try {
    const mfile = join(mdir, 'memory.json');
    const mem = new MemoryStore(mfile);
    check('empty memory adds nothing to the prompt', mem.prompt() === '');
    const a = mem.add('Runs a push/pull/legs split, 5 days a week');
    const again = mem.add('  runs a push/pull/legs split,   5 days a week ');
    check('duplicate memory is not stored twice', again.id === a.id && again.existed === true && mem.list().length === 1);
    check('a new memory is not flagged as existing', !a.existed);
    const b = mem.add('Home airport is SJC');
    mem.update(b.id, 'Home airport is SJC; will use SFO for international');
    let tooLong = '';
    try {
      mem.add('x'.repeat(400));
    } catch (err) {
      tooLong = (err as Error).message;
    }
    check('overlong memory is refused', tooLong.includes('300'), tooLong);
    const reread = new MemoryStore(mfile);
    check('memories survive a restart', reread.list().length === 2 && reread.list()[1]!.text.includes('SFO'));
    reread.forget(a.id);
    const prompt = reread.prompt();
    check('prompt lists remaining memories with ids', prompt.includes(`[${b.id}] Home airport is SJC`) && !prompt.includes('push/pull'));
  } finally {
    rmSync(mdir, { recursive: true, force: true });
  }
}

// --- training log, through the assistant's tools ---
{
  const gdir = mkdtempSync(join(tmpdir(), 'squire-gym-'));
  const store = new PlanStore(gdir);
  try {
    const service = new TrainingService(store, () => new Date(2026, 10, 12, 18, 0));
    const tools = new Map(trainingTools(service).map((h) => [h.def.name, h]));
    const call = async (name: string, args: Record<string, unknown> = {}) => String(await tools.get(name)!.run(args));

    check('splits come from the real log', (await call('training_splits')).includes('Push day'));
    const loaded = await call('training_load_split', { name: 'push day', date: '' });
    check('loading a split fills today', loaded.includes('Barbell bench press'), loaded.split('\n')[0]);
    const logged = await call('training_log_set', { exercise: 'barbell bench press', weight: 185, reps: 5, date: '' });
    check('a chat-logged set lands in the log', logged.includes('185 lb × 5') && logged.includes('set 1 of'), logged);
    check('/today sees the chat-logged set', service.session().includes('185×5'));
    const history = await call('training_history', { days: 7 });
    check('history lists the set by date', history.includes('2026-11-12') && history.includes('185×5'), history.split('\n')[1]);
    let refusal = '';
    try {
      await call('training_load_split', { name: 'Pull day', date: '' });
    } catch (err) {
      refusal = (err as Error).message;
    }
    check('reloading over logged sets is refused', refusal.includes('already has logged sets'), refusal);
    let unknown = '';
    try {
      await call('training_log_set', { exercise: 'Curls', weight: 30, reps: 10, date: '' });
    } catch (err) {
      unknown = (err as Error).message;
    }
    check('unknown exercise names what is there', unknown.includes('Barbell bench press'), unknown.slice(0, 80));
    check('week facts are computed, not guessed', (await call('training_week')).length > 0);
  } finally {
    store.close();
    rmSync(gdir, { recursive: true, force: true });
  }
}

// --- saved places ---
{
  // The getlist payload: prefix, then data[0][4] title and data[0][8] entries.
  const entry = (name: string, address: string, lat: number, lng: number, note?: string) => [
    null,
    [null, null, `${name}, ${address}`, null, address, [null, null, lat, lng], ['0x80858', '0x1a2b'], '/g/abc'],
    name,
    note ?? '',
  ];
  const payload = `)]}'\n${JSON.stringify([[null, null, null, null, 'Dessert', null, null, null, [entry('Tartine Bakery', '600 Guerrero St, SF', 37.7614, -122.4241, 'morning bun'), entry('Bi-Rite Creamery', '3692 18th St, SF', 37.7616, -122.4257)]]])}`;
  const parsed = parseListResponse(payload);
  check('shared list: title and places parsed', parsed.title === 'Dessert' && parsed.places.length === 2, JSON.stringify(parsed.places[0]));
  check('shared list: coordinates, address, note, cid', parsed.places[0]!.location?.lat === 37.7614 && parsed.places[0]!.note === 'morning bun' && parsed.places[0]!.cid === '0x80858:0x1a2b' && !parsed.places[1]!.note);
  check('maps link from a cid is a decimal cid link', mapsLink('0x80858:0x1a2b', 'x') === 'https://maps.google.com/?cid=6699');

  // Hours on the place's own clock: Thu 12 Nov 2026 21:51 UTC is 13:51 in LA.
  const hours: PlaceDetails = {
    placeId: 'p1',
    timeZone: LA,
    periods: [
      { open: { day: 4, hour: 11, minute: 0 }, close: { day: 4, hour: 22, minute: 0 } },
      // Saturday 18:00 to Sunday 02:00, across the week boundary.
      { open: { day: 6, hour: 18, minute: 0 }, close: { day: 0, hour: 2, minute: 0 } },
    ],
    weekdayHours: ['Monday: Closed', 'Tuesday: Closed', 'Wednesday: Closed', 'Thursday: 11:00 AM – 10:00 PM', 'Friday: Closed', 'Saturday: 6:00 PM – 2:00 AM', 'Sunday: Closed'],
    fetchedAt: nov12.toISOString(),
  };
  check('open during its hours', isOpenAt(hours, nov12) === true);
  check('closed after them', isOpenAt(hours, new Date('2026-11-13T07:00:00Z')) === false); // Thu 23:00 LA
  check('open past midnight into Sunday', isOpenAt(hours, new Date('2026-11-15T09:30:00Z')) === true); // Sun 01:30 LA
  check('24/7 has no close', isOpenAt({ ...hours, periods: [{ open: { day: 0, hour: 0, minute: 0 } }] }, nov12) === true);
  check('unknown hours are unknown, not closed', isOpenAt({ placeId: 'p2', fetchedAt: '' }, nov12) === undefined);
  check("today's hours line is the local weekday", todaysHours(hours, nov12) === 'Thursday: 11:00 AM – 10:00 PM');

  const pdir = mkdtempSync(join(tmpdir(), 'squire-places-'));
  try {
    const places = new SavedPlaces({ file: join(pdir, 'places.json'), listUrls: [] });
    places.store.data.lists = [{ url: 'u1', name: 'Dessert' }, { url: 'u2', name: 'Bars' }];
    places.store.data.places = [
      { key: 'c1', list: 'Dessert', name: 'Tartine Bakery', location: { lat: 37.7614, lng: -122.4241 }, note: 'morning bun', source: 'list', details: hours },
      { key: 'c2', list: 'Dessert', name: 'Bi-Rite Creamery', location: { lat: 37.7616, lng: -122.4257 }, source: 'list' },
      { key: 'c3', list: 'Bars', name: 'Trick Dog', location: { lat: 37.759, lng: -122.4114 }, source: 'list', details: { ...hours, periods: [] } },
      { key: 'chat-1', list: 'Dessert', name: 'Dandelion Chocolate', location: { lat: 37.7609, lng: -122.4214 }, source: 'chat' },
    ];
    // "home" and a named area resolve from the remembered geocodes; no API here.
    places.store.data.geocodes['mission dolores'] = { lat: 37.7598, lng: -122.4271, label: 'Mission Dolores, SF' };
    const tools = new Map(placesTools(places, LA, { clock: () => nov12 }).map((h) => [h.def.name, h]));
    const find = async (args: Record<string, unknown>) =>
      String(await tools.get('places_find')!.run({ list: '', text: '', near: '', within_km: 0, open_now: false, limit: 10, ...args }));
    const fail = (name: string, args: Record<string, unknown>) => {
      try {
        void tools.get(name)!.run(args);
        return '';
      } catch (err) {
        return (err as Error).message;
      }
    };

    const dessert = await find({ list: 'des' });
    check('a list prefix picks the list', dessert.includes('Tartine') && !dessert.includes('Trick Dog'), dessert);
    check('the owner\'s note is searchable', (await find({ text: 'bun' })).startsWith('Tartine Bakery'));
    const near = await find({ near: 'Mission Dolores', within_km: 0.4 });
    check('near a place: nearest first, radius applied', near.split('\n')[1]?.startsWith('Bi-Rite') === true && !near.includes('Trick Dog'), near);
    const open = await find({ open_now: true });
    check('open now keeps only known-open spots and counts the unknown', open.includes('Tartine') && !open.includes('Bi-Rite') && open.includes('3 matching places left out'), open);
    check('removing a Google list entry is refused', fail('places_remove', { key: 'c1' }).includes('remove it there'));
    await tools.get('places_remove')!.run({ key: 'chat-1' });
    check('a chat-added place can be removed', !new SavedPlaces({ file: join(pdir, 'places.json'), listUrls: [] }).places().some((p) => p.key === 'chat-1'));
    const unknownList = await Promise.resolve()
      .then(() => tools.get('places_add')!.run({ list: 'Japan trip', query: 'Ichiran Shibuya Tokyo', near: '', note: '', new_list: false }))
      .then(() => '', (err: Error) => err.message);
    check('an unknown list is refused, naming the real ones', unknownList.includes('no "Japan trip" list') && unknownList.includes('Dessert, Bars'), unknownList);
    // Seen in #misc, Nov 14: SF spots from a TikTok matched namesakes in San
    // Jose, Burlingame and Sunnyvale and were saved anyway.
    const sf = { lat: 37.7749, lng: -122.4194 };
    const fakeHit = (name: string, location: { lat: number; lng: number }) => ({ name, address: name, location, details: { placeId: name, fetchedAt: '' } });
    const withApi = places as unknown as { api?: { find: (q: string) => Promise<unknown> } };
    withApi.api = { find: async (q) => (q.startsWith('F1rst') ? fakeHit('The F1rst Take, San Jose', { lat: 37.3382, lng: -121.8863 }) : fakeHit('Bar Shoji, New Montgomery', { lat: 37.7867, lng: -122.3998 })) };
    const farMatch = await places.add('Bars', 'F1rst Take', sf).then(() => '', (err: Error) => err.message);
    check('a match far from the area asked for is not saved', farMatch.startsWith('Not saved') && farMatch.includes('San Jose') && !places.places().some((p) => p.name.includes('F1rst')), farMatch);
    const nearMatch = await places.add('Bars', 'Shoji', sf);
    check('a match in the area asked for is saved', nearMatch.name.startsWith('Bar Shoji'));
    withApi.api = undefined;
    let noKey = '';
    await places.add('Dessert', 'Mitchell\'s Ice Cream', undefined).catch((err: Error) => (noKey = err.message));
    check('adding without an API key says what is missing', noKey.includes('GOOGLE_MAPS_API_KEY'), noKey);
  } finally {
    rmSync(pdir, { recursive: true, force: true });
  }
}

// --- the journal of past conversations ---
{
  const jdir = mkdtempSync(join(tmpdir(), 'squire-journal-'));
  try {
    const at = (iso: string) => new Date(iso);
    const lines: JournalLine[] = [
      { id: '1', fromOwner: true, at: at('2026-11-12T20:00:00Z'), text: 'book Sakura Hostel in Shibuya Jun 3-8' },
      { id: '2', fromOwner: false, at: at('2026-11-12T20:01:00Z'), text: 'Done, saved to Travel/Japan.' },
      { id: '3', fromOwner: true, at: at('2026-11-13T02:00:00Z'), text: 'riven for alex sunday' },
    ];
    const sessions = splitSessions(lines);
    check('a long gap starts a new conversation', sessions.length === 2 && sessions[0]!.length === 2, String(sessions.map((s) => s.length)));
    const parsed = parseSummary('Japan trip bookings: Sakura Hostel Jun 3-8 booked.\nONGOING 2027-06-12: Japan trip (Tokyo, Osaka)');
    check('an ongoing plan is read off the last line', parsed?.ongoing?.until === '2027-06-12' && parsed.summary === 'Japan trip bookings: Sakura Hostel Jun 3-8 booked.', JSON.stringify(parsed));
    check('SKIP keeps nothing', parseSummary('SKIP') === undefined && parseSummary('  ') === undefined);

    const file = join(jdir, 'journal.json');
    const journal = new Journal(file);
    const entry = (n: number, summary: string, ongoing?: { until: string; topic: string }) => ({
      channelId: 'c1',
      channelName: n === 0 ? 'travel' : 'misc',
      from: new Date(Date.UTC(2026, 10, 1 + n)).toISOString(),
      to: new Date(Date.UTC(2026, 10, 1 + n, 1)).toISOString(),
      summary,
      ongoing,
    });
    journal.done('c1', '10', entry(0, 'Japan trip: Sakura Hostel Shibuya Jun 3-8, Riverside Inn Osaka Jun 8-10.', { until: '2027-06-12', topic: 'Japan trip' }));
    for (let n = 1; n <= 8; n++) journal.done('c1', String(10 + n), entry(n, n === 1 ? 'Pickleball paddles compared: Joola Perseus.' : `Chat number ${n} about cards.`));
    const reloaded = new Journal(file);
    check('the journal and cursor survive a restart', reloaded.entries().length === 9 && reloaded.cursor('c1') === '18');
    const now = new Date('2026-11-14T12:00:00Z');
    const prompt = reloaded.prompt(LA, now);
    check('an ongoing plan stays in the prompt past the recent few', prompt.includes('ongoing until 2027-06-12: Japan trip') && prompt.includes('Sakura'), prompt);
    check('only the latest others are in the prompt', !prompt.includes('Pickleball') && prompt.includes('Chat number 8'), prompt);
    const related = reloaded.related('which paddle did I like', LA, now);
    check('an older conversation is found by its words', related.includes('Joola') && !related.includes('Sakura'), related);
    check('nothing related, no note', reloaded.related('https://www.instagram.com/reel/abc', LA, now) === '');
    check('a plan that has passed drops out', !reloaded.prompt(LA, new Date('2027-07-01T00:00:00Z')).includes('ongoing until'));
    const recall = String(await journalTools(reloaded, LA)[0]!.run({ query: 'Osaka hotel' }));
    check('recall searches every past conversation', recall.includes('Riverside Inn'), recall);
    const turns = withRelated([{ role: 'user', content: [{ type: 'text', text: 'what paddle again?' }] }], reloaded, LA);
    const last = turns.at(-1);
    check('related conversations ride on the latest message', last?.role === 'user' && last.content.length === 2 && JSON.stringify(last.content[1]).includes('Joola'));

    let summarySystem = '';
    const summarizer: LLM = {
      retryable: () => false,
      async generate(_m, req) {
        summarySystem = req.system + JSON.stringify(req.turns);
        const text = 'Japan trip: booked Sakura.\nONGOING 2027-06-12: Japan trip';
        return { stop: 'done', text, calls: [], sources: new Sources(), turn: { role: 'assistant', text } };
      },
    };
    const summary = await summarize(summarizer, { model: 'm', effort: 'low' }, 'travel', sessions[0]!, LA);
    check('a conversation is summarised from its transcript', summary?.ongoing?.topic === 'Japan trip' && summarySystem.includes('Owner: book Sakura') && summarySystem.includes('Squire: Done'), summarySystem.slice(-200));
    check('no web tools when none are allowed', webTools('claude-haiku-5-5', 0).length === 0);
  } finally {
    rmSync(jdir, { recursive: true, force: true });
  }
}

// --- recipes only from pages actually read ---
{
  const vdir = mkdtempSync(join(tmpdir(), 'squire-recipes-'));
  try {
    const vault = new Vault(vdir);
    const reads = new ReadLog();
    const tools = new Map(notesTools(vault, LA, reads).map((h) => [h.def.name, h]));
    const save = async (args: Record<string, unknown>) => {
      try {
        return String(await tools.get('save_note')!.run({ mode: 'create', folder: 'Recipes/Meal', sources: [], ...args }));
      } catch (err) {
        return `ERR ${(err as Error).message}`;
      }
    };
    check('reads: links match however they are written', pageKey('https://www.Cook.example/curry/?utm=1#x') === pageKey('http://cook.example/curry'));
    check('recipe with no sources is refused', (await save({ title: 'Curry', content: '- 1 kg chicken' })).startsWith('ERR A recipe needs its sources'));
    check('recipe citing a page never opened is refused', (await save({ title: 'Curry', content: '- 1 kg chicken', sources: ['https://cook.example/curry'] })).includes('never opened'));
    const s = new Sources();
    s.opened.set('https://cook.example/curry', 'Kerala Curry');
    reads.recordFetches({ sources: s });
    reads.recordTools(
      [{ id: 'v', name: 'watch_video', input: { url: 'https://www.instagram.com/reel/abc/?igsh=x' } }, { id: 'p', name: 'fetch_page', input: { url: 'https://blocked.example/r' } }],
      [{ callId: 'v', name: 'watch_video', content: 'Title: Ube muffins' }, { callId: 'p', name: 'fetch_page', content: 'HTTP 403', isError: true }],
    );
    const ok = await save({ title: 'Curry', content: '- 1 kg chicken', sources: ['https://www.cook.example/curry/'] });
    const note = vault.read('Recipes/Meal/Curry.md') ?? '';
    check('recipe from an opened page is saved with a linked Sources list', ok.startsWith('Saved') && note.includes('## Sources\n- [Kerala Curry](https://www.cook.example/curry/)'), note);
    check('a watched video counts as read', (await save({ title: 'Muffins', content: '- ube', sources: ['https://instagram.com/reel/abc'] })).startsWith('Saved'));
    check('a page that failed to open does not count', (await save({ title: 'R', content: 'x', sources: ['https://blocked.example/r'] })).includes('never opened'));
    check('a recipe the owner gave needs no link', (await save({ title: 'Mine', content: 'x', sources: ['owner'] })).startsWith('Saved') && vault.read('Recipes/Meal/Mine.md')!.includes('From the owner'));
    check('other notes need no sources', (await save({ title: 'Trip', content: 'x', folder: 'Travel' })).startsWith('Saved'));
    check('appending to a recipe needs no sources', (await save({ title: 'Curry', content: 'Tip: rest it.', mode: 'append' })).startsWith('Appended'));
  } finally {
    rmSync(vdir, { recursive: true, force: true });
  }
}

// --- Obsidian notes ---
{
  const vdir = mkdtempSync(join(tmpdir(), 'squire-vault-'));
  try {
    const vault = new Vault(vdir);
    vault.write('notes/cold brew.md', 'Ratio 1:8, steep 16 hours.\nFilter twice.');
    vault.write('.obsidian/workspace.md', 'cold brew settings');
    const tools = new Map(notesTools(vault, LA).map((h) => [h.def.name, h]));
    const call = async (name: string, args: Record<string, unknown>) => String(await tools.get(name)!.run(args));
    const fail = async (name: string, args: Record<string, unknown>) => {
      try {
        await call(name, args);
        return '';
      } catch (err) {
        return (err as Error).message;
      }
    };

    const found = await call('search_notes', { query: 'cold steep' });
    check('search matches title and text together, showing the line', found.startsWith('notes/cold brew.md') && found.includes('Ratio 1:8'), found);
    check('search skips Obsidian\'s own folder', !found.includes('.obsidian'));
    check('read returns the note', (await call('read_note', { path: 'notes/cold brew.md' })).includes('Filter twice.'));
    check('read refuses paths outside the vault', (await fail('read_note', { path: '../outside.md' })).includes('outside the vault'));

    const saved = await call('save_note', { title: 'Pork bulgogi: v2', content: '- 1 lb pork', mode: 'create', folder: '' });
    const inbox = vault.list('Squire/Inbox');
    check('save writes a sanitised file in the inbox', inbox.length === 1 && inbox[0] === 'Squire/Inbox/Pork bulgogi v2.md' && saved.includes(inbox[0]!), inbox.join());
    check('create refuses to overwrite', (await fail('save_note', { title: 'Pork bulgogi: v2', content: 'x', mode: 'create' })).includes('already exists'));
    await call('save_note', { title: 'Pork bulgogi: v2', content: '- 2 tbsp gochujang', mode: 'append' });
    const note = vault.read(inbox[0]!)!;
    check('append keeps what was there', note.startsWith('---\ncreated:') && note.includes('- 1 lb pork') && note.trimEnd().endsWith('- 2 tbsp gochujang'), note);

    // Organising the vault: folders, moves, renames, trash.
    await call('save_note', { title: 'Japan trip bookings', content: '- Tokyo stay booked', mode: 'create', folder: '' });
    const moved = await call('move_note', { from: 'Squire/Inbox/Japan trip bookings.md', to: 'Travel/Japan' });
    check('a note moved onto a new folder keeps its name', vault.read('Travel/Japan/Japan trip bookings.md')?.includes('Tokyo') === true && !vault.read('Squire/Inbox/Japan trip bookings.md'), moved);
    await call('save_note', { title: 'Osaka', content: '- to book', mode: 'create', folder: '/Travel/Japan/' });
    check('save writes into a named folder', vault.read('Travel/Japan/Osaka.md')?.includes('to book') === true);
    const tree = await call('list_notes', { folder: 'Travel' });
    check('list shows subfolders and notes', tree.startsWith('Travel/\n') && tree.includes('Travel/Japan/') && tree.includes('Travel/Japan/Osaka.md'), tree);
    await call('move_note', { from: 'Travel', to: 'Trips' });
    check('a whole folder can be renamed', vault.list('Trips').length === 2 && vault.list('Travel').length === 0);
    check('move refuses to overwrite', (await fail('move_note', { from: 'Trips/Japan/Osaka.md', to: 'Trips/Japan/Japan trip bookings.md' })).includes('already exists'));
    check('move refuses to leave the vault', (await fail('move_note', { from: 'Trips/Japan/Osaka.md', to: '../Osaka.md' })).includes('".."'));
    const whole = await call('list_notes', { folder: '' });
    check('list shows the whole vault from the root, without dot-folders', whole.startsWith('the vault root\n') && whole.includes('  notes/cold brew.md') && whole.includes('  Trips/Japan/') && !whole.includes('.obsidian'), whole);
    await call('move_note', { from: 'notes/cold brew.md', to: 'Recipes' });
    check('notes outside the old Squire folder can be organised too', vault.read('Recipes/cold brew.md')?.includes('Filter twice.') === true);
    await call('move_note', { from: 'Recipes/cold brew.md', to: '.obsidian' });
    check("Obsidian's own folders stay out of reach", vault.read('obsidian/cold brew.md') !== undefined && vault.read('.obsidian/cold brew.md') === undefined);
    check('the vault root cannot be deleted', (await fail('delete_note', { path: '' })).includes('vault root'));
    check('the vault root cannot be moved', (await fail('move_note', { from: '/', to: 'Elsewhere' })).includes('vault root'));
    vault.write('Training/Training.md', 'x');
    vault.write('Squire/Workouts/2026-11-12 Workout.md', 'x');
    check('the training log is off limits', (await fail('move_note', { from: 'Training/Training.md', to: 'Inbox' })).includes('training'));
    check('saving into the training log is refused', (await fail('save_note', { title: 'x', content: 'x', mode: 'create', folder: 'Training' })).includes('training'));
    check('the workout notes are off limits', (await fail('delete_note', { path: 'Squire/Workouts/2026-11-12 Workout.md' })).includes('training'));
    check('recipes are not saved under the bot folder', (await fail('save_note', { title: 'Pad See Ew', content: 'x', mode: 'create', folder: 'Squire/Recipes/Meal' })).includes('"Recipes/Meal"'));
    check('notes are not moved under the bot folder', (await fail('move_note', { from: 'Trips/Japan/Osaka.md', to: 'Squire/Travel/Japan' })).includes('vault root'));
    vault.write('Squire/Recipes/Meal/Pad See Ew.md', 'x');
    await call('move_note', { from: 'Squire/Recipes/Meal/Pad See Ew.md', to: 'Recipes/Meal' });
    check('a misplaced note can be moved out of the bot folder', vault.read('Recipes/Meal/Pad See Ew.md') === 'x');
    await call('delete_note', { path: 'Trips/Japan/Osaka.md' });
    check('delete puts the note in Obsidian\'s trash', vault.read('.trash/Osaka.md')?.includes('to book') === true && !vault.read('Trips/Japan/Osaka.md'));
  } finally {
    rmSync(vdir, { recursive: true, force: true });
  }
}

// --- opening links, with a scripted stand-in for the network ---
{
  const open = async () => {};
  const reply = (status: number, body: string | Uint8Array, headers: Record<string, string> = {}) => new Response(body, { status, headers });
  const routes = (table: Record<string, () => Response>): Fetcher => async (url) => {
    const make = table[url];
    if (!make) throw new Error(`unexpected fetch ${url}`);
    return make();
  };

  check('urls lose trailing punctuation', findUrls('see https://a.example/x?y=1). and https://b.example/z,').join(' ') === 'https://a.example/x?y=1 https://b.example/z');
  check('t.co is a short link, a blog is not', isShortLink('https://t.co/AbCdEf1234?ssr=true') && !isShortLink('https://blog.example/x'));
  check('a pasted Discord image link is recognised', isDiscordCdn('https://cdn.discordapp.com/attachments/1/2/image0.jpg?ex=1') && !isDiscordCdn('https://cdn.discordapp.com/avatars/1/2.png'));
  const msgLink = parseDiscordLink('https://discord.com/channels/111111111111111111/222222222222222222/333333333333333333');
  check('a Discord message link is parsed', msgLink?.channelId === '222222222222222222' && msgLink.messageId === '333333333333333333');
  check('a Discord channel link has no message', parseDiscordLink('https://ptb.discord.com/channels/1/2')?.messageId === undefined && !parseDiscordLink('https://discord.gg/abc'));
  check('private addresses are refused', ['127.0.0.1', '10.1.2.3', '192.168.1.5', '172.20.0.1', '169.254.1.1', '::1', 'fd00::1', '::ffff:127.0.0.1'].every(isPrivateAddress) && !isPrivateAddress('104.16.1.1'));
  const resized = new URL(resizedDiscordUrl('https://cdn.discordapp.com/attachments/1/2/big.png?ex=1', 4000, 3000));
  check('oversized images go through the resizing proxy', resized.hostname === 'media.discordapp.net' && resized.searchParams.get('width') === '1568' && resized.searchParams.get('height') === '1176', resized.href);

  const viaHeader = await expandShortLink('https://t.co/a', routes({ 'https://t.co/a': () => reply(301, '', { location: 'https://pastebin.com/AbCd1234' }) }), open);
  check('a short link is followed to where it leads', viaHeader === 'https://pastebin.com/AbCd1234', viaHeader);
  const viaMeta = await expandShortLink('https://t.co/b', routes({ 'https://t.co/b': () => reply(200, '<meta http-equiv="refresh" content="0;URL=https://example.com/r?a=1&amp;b=2">') }), open);
  check("t.co's refresh page is followed too", viaMeta === 'https://example.com/r?a=1&b=2', viaMeta);

  const png = new Uint8Array([137, 80, 78, 71]);
  const img = await fetchImage('https://cdn.discordapp.com/attachments/1/2/i.png', routes({ 'https://cdn.discordapp.com/attachments/1/2/i.png': () => reply(200, png, { 'content-type': 'image/png' }) }), open);
  check('an image downloads as base64', img.mimeType === 'image/png' && img.data === Buffer.from(png).toString('base64'));
  const why = async (p: Promise<unknown>) => p.then(() => '', (e: Error) => e.message);
  check('an expired image link says so', (await why(fetchImage('https://x/i.png', routes({ 'https://x/i.png': () => reply(404, '') }), open))).includes('expired'));
  check('a page is not taken for an image', (await why(fetchImage('https://x/i', routes({ 'https://x/i': () => reply(200, '<html>', { 'content-type': 'text/html' }) }), open))).includes('text/html'));
  check('an image over the limit is refused', (await why(fetchImage('https://x/big', routes({ 'https://x/big': () => reply(200, '', { 'content-type': 'image/png', 'content-length': String(MAX_IMAGE_BYTES + 1) }) }), open))).includes('limit'));
  check('nothing on the local network is fetched', (await why(fetchPage('http://127.0.0.1:11434/'))).includes('private'));
  check('a redirect into the local network is refused', (await why(fetchPage('https://public.example/', routes({ 'https://public.example/': () => reply(302, '', { location: 'http://127.0.0.1/' }) }), async (u) => {
    if (isPrivateAddress(u.hostname)) throw new Error(`${u.hostname} is a private address`);
  }))).includes('private'));

  const recipePage = `<html><head><title>Galbi Jjim &amp; more</title>
    <script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"WebPage"},{"@type":["Recipe"],"name":"Galbi jjim","recipeYield":["4"],
    "recipeIngredient":["2 pounds beef short ribs","&frac13; cup soy sauce"],
    "recipeInstructions":[{"@type":"HowToSection","name":"Ribs","itemListElement":[{"@type":"HowToStep","text":"Soak the ribs."},{"@type":"HowToStep","text":"Blanch them."}]}]}]}</script>
    </head><body><nav>Home | Recipes</nav><script>var x = 1;</script><h1>Galbi jjim</h1><p>Braised short ribs.</p><ul><li>one</li><li>two</li></ul></body></html>`;
  const recipe = recipeFromHtml(recipePage);
  check('a recipe is read from structured data', !!recipe && recipe.includes('Recipe: Galbi jjim') && recipe.includes('- 2 pounds beef short ribs') && recipe.includes('Ribs:') && recipe.includes('2. Soak the ribs.'), recipe);
  const page = await fetchPage('https://maangchi.example/galbi', routes({ 'https://maangchi.example/galbi': () => reply(200, recipePage, { 'content-type': 'text/html; charset=utf-8' }) }), open);
  check('a page comes back as title, recipe and text', page.includes('Title: Galbi Jjim & more') && page.includes('Recipe: Galbi jjim') && page.includes('Braised short ribs.') && page.includes('- one') && !page.includes('var x') && !page.includes('Home | Recipes'), page);
  const blocked = await why(fetchPage('https://maangchi.example/x', routes({ 'https://maangchi.example/x': () => reply(403, '<title>Attention Required! | Cloudflare</title>', { 'content-type': 'text/html', server: 'cloudflare' }) }), open));
  check('a bot check is reported plainly', blocked.includes('bot check') && blocked.includes('screenshot'), blocked);

  const names = (tools: ReturnType<typeof linkTools>) => tools.map((t) => t.def.name).join(',');
  check('without Discord there is only fetch_page', names(linkTools()) === 'fetch_page');
  const reads: { channelId: string; messageId?: string; count: number }[] = [];
  const withDiscord = linkTools({ read: async (link, count) => (reads.push({ ...link, count }), { content: 'ok', images: [] }) });
  await withDiscord[1]!.run({ link: 'https://discord.com/channels/1/2/3', count: 500 });
  check('read_discord_messages caps the count', reads[0]?.messageId === '3' && reads[0].count === 100, JSON.stringify(reads));
  check('fetch_page sends Discord links to the other tool', (await why(Promise.resolve().then(() => withDiscord[0]!.run({ url: 'https://discord.com/channels/1/2/3' })))).includes('read_discord_messages'));
}

// --- forwarded messages ---
{
  const att = (name: string) => ({ name, url: `https://cdn.discordapp.com/attachments/1/2/${name}`, contentType: 'image/png' });
  const coll = <T,>(items: T[]) => new Map(items.map((v, i) => [String(i), v]));
  const forward = {
    content: '',
    attachments: coll([]),
    embeds: [],
    createdAt: new Date(),
    messageSnapshots: coll([{ content: 'galbi jjim https://t.co/x', attachments: coll([att('card.png')]), embeds: [{ title: 'Galbi', description: null, url: 'https://maangchi.com/g' }], createdAt: new Date('2026-11-12T21:51:00Z') }]),
  } as never;
  const text = messageText(forward, LA);
  check('a forward is written out, with when, files and previews', text === '[forwarded message from Thu 12 Nov, 13:51: galbi jjim https://t.co/x [attached: card.png] [preview: Galbi · https://maangchi.com/g]]', text);
  check("a forward's attachments count as the message's", messageAttachments(forward).map((a) => a.name).join() === 'card.png');
  const plain = { content: 'hi', attachments: coll([att('a.png')]), embeds: [], createdAt: new Date(), messageSnapshots: coll([]) } as never;
  check('an ordinary message is unchanged', messageText(plain, LA) === 'hi' && messageAttachments(plain).length === 1);
}

// --- reading video links ---
{
  const f = (ext: string, url = `https://captions/${ext}`) => ({ ext, url });
  const own = pickCaptions({ subtitles: { 'en-GB': [f('vtt'), f('json3')] }, automatic_captions: { 'en-orig': [f('json3')] } });
  check("the uploader's captions win over automatic ones", own?.lang === 'en-GB' && !own.auto && own.format.ext === 'json3', JSON.stringify(own));
  const auto = pickCaptions({ automatic_captions: { fr: [f('json3')], 'en-orig': [f('json3')], en: [f('json3')] } });
  check('automatic captions use the spoken English track', auto?.lang === 'en-orig' && auto.auto);
  const korean = pickCaptions({ automatic_captions: { 'ko-orig': [f('vtt')], en: [] as never[], fr: [f('json3')] } });
  check('with no English, the original language, not a translation', korean?.lang === 'ko-orig', JSON.stringify(korean));
  check('no captions is undefined', pickCaptions({}) === undefined && pickCaptions({ subtitles: { live_chat: [f('json3')] } }) === undefined);
  const json3 = JSON.stringify({ events: [{ segs: [{ utf8: 'add the ' }, { utf8: 'flour' }] }, { segs: [{ utf8: '\n' }] }, { segs: [{ utf8: 'add the flour' }] }, { segs: [{ utf8: 'bake &amp; cool' }] }] });
  check('json3 captions become one line of text', captionText(json3, 'json3') === 'add the flour bake & cool', captionText(json3, 'json3'));
  const vtt = 'WEBVTT\nKind: captions\n\n00:00:01.000 --> 00:00:02.000\n<c>one cup</c> sugar\n\n00:00:02.000 --> 00:00:03.000\none cup sugar\n\n00:00:03.000 --> 00:00:04.000\nbeat it';
  check('vtt captions lose timings, tags and repeats', captionText(vtt, 'vtt') === 'one cup sugar beat it', captionText(vtt, 'vtt'));
  const desc = describeVideo({ title: 'Cookies', uploader: 'Dished', duration: 50, description: '1/3 cup sugar', chapters: [{ title: 'mix', start_time: 75 }] }, undefined, 'none available');
  check('a video reads as title, creator, description and transcript', desc.includes('Video: Cookies') && desc.includes('By: Dished') && desc.includes('Length: 0:50') && desc.includes('- 1:15 mix') && desc.includes('1/3 cup sugar') && desc.includes('no captions'), desc);
  // Seen in #misc, Nov 14: a TikTok photo post of SF places couldn't be read
  // at all, and Harry had to screenshot every slide.
  const ttPage = `<html><script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify({
    __DEFAULT_SCOPE__: { 'webapp.video-detail': { itemInfo: { itemStruct: { desc: '#sf cafes', author: { uniqueId: 'y3on_hwa' }, imagePost: { images: [{ imageURL: { urlList: ['https://p16.tiktokcdn-us.com/a.jpeg', 'https://p19.tiktokcdn-us.com/a.jpeg'] } }, { imageURL: { urlList: ['https://p16.tiktokcdn-us.com/b.jpeg'] } }] } } } } },
  })}</script></html>`;
  const slides = tiktokSlides(ttPage);
  check('a TikTok photo post reads as its slides and caption', slides?.images.join(',') === 'https://p16.tiktokcdn-us.com/a.jpeg,https://p16.tiktokcdn-us.com/b.jpeg' && slides.caption === '#sf cafes' && slides.author === 'y3on_hwa', JSON.stringify(slides));
  check('a TikTok page without slides gives nothing', tiktokSlides('<html><script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">{"__DEFAULT_SCOPE__":{}}</script></html>') === undefined);
  // An Instagram /p/ carousel came back as a playlist whose image slides had
  // no video formats, so yt-dlp dropped them and the bot asked for screenshots.
  const ig = (key = 'Instagram') => ({ extractor_key: key });
  const carousel = instagramSlides({ ...ig(), _type: 'playlist', entries: [{ thumbnail: 'https://cdn.ig/1.jpg', formats: [] }, { thumbnail: 'https://cdn.ig/2.jpg', formats: [{}] }, null, { thumbnail: 'https://cdn.ig/4.jpg' }] });
  check('an Instagram carousel reads as its slide pictures', carousel?.images.join(',') === 'https://cdn.ig/1.jpg,https://cdn.ig/2.jpg,https://cdn.ig/4.jpg' && carousel.videos.join() === '2' && carousel.missing.join() === '3', JSON.stringify(carousel));
  check('a one-picture Instagram post reads as that picture', instagramSlides({ ...ig(), thumbnail: 'https://cdn.ig/p.jpg', formats: [] })?.images.join() === 'https://cdn.ig/p.jpg');
  check('an Instagram reel still reads as a video', instagramSlides({ ...ig(), thumbnail: 'https://cdn.ig/r.jpg', formats: [{}] }) === undefined);
  check('only Instagram posts read as slides', instagramSlides({ ...ig('Youtube'), thumbnail: 'https://i.ytimg.com/x.jpg', formats: [] }) === undefined);
  check('a transcript of only sound tags means no speech', cleanTranscript(' Music') === '' && cleanTranscript('[Music] ♪ (applause)') === '' && cleanTranscript(' you') === '');
  const looped = cleanTranscript('오늘의 요리는! 물을 끓여줍니다. 고추장 양파 고추장, 고추장, 고추장, 고추장, 고추장, 고추장, 고추장, 고추장');
  check('a word Whisper loops on is collapsed', looped === '오늘의 요리는! 물을 끓여줍니다. 고추장 양파 고추장 [repeated]', looped);
  const real = 'add 1 tablespoon of soy sauce and 1 tablespoon of sugar';
  check('ordinary repeats are kept', cleanTranscript(real) === real && cleanTranscript('[Music] Add the flour.') === 'Add the flour.');
  check('the video tool refuses Discord links', (await Promise.resolve().then(() => videoTools()[0]!.run({ url: 'https://discord.com/channels/1/2/3' })).then(() => '', (e: Error) => e.message)).includes('read_discord_messages'));
  check('nothing on the local network is opened as a video', (await readVideo('http://192.168.1.10/cam').then(() => '', (e: Error) => e.message)).includes('private'));
}

// --- activity log, usage, review digest, voice notes, morning brief ---
{
  const adir = mkdtempSync(join(tmpdir(), 'squire-activity-'));
  try {
    const metered = fromMessage({
      stop_reason: 'end_turn',
      model: 'claude-haiku-5-5',
      content: [{ type: 'text', text: 'hi', citations: null }],
      usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 5000, cache_creation_input_tokens: 0, server_tool_use: { web_search_requests: 2, web_fetch_requests: 1 } },
    } as never);
    check('anthropic: usage is read off the response', metered.usage?.input === 1000 && metered.usage.cacheRead === 5000 && metered.usage.webSearches === 2 && metered.usage.model === 'claude-haiku-5-5', JSON.stringify(metered.usage));
    const haikuMillion = costUsd({ ...noUsage('claude-haiku-5-5'), input: 1_000_000 });
    const sonnet = costUsd({ ...noUsage('claude-sonnet-5-5'), input: 100_000, output: 10_000, webSearches: 3 });
    check('cost: Haiku 5.5 input at $0.10 per million', Math.abs(haikuMillion - 0.1) < 1e-9, String(haikuMillion));
    check('cost: Sonnet 5.5 tokens plus searches', Math.abs(sonnet - (0.2 + 0.1 + 0.03)) < 1e-9, String(sonnet));
    check('cost: usage adds up', addUsage({ ...noUsage('m'), input: 1 }, { ...noUsage('m'), input: 2, webSearches: 1 }).input === 3);
    check('cost: tiny amounts show as <$0.01', dollars(0.004) === '<$0.01' && dollars(1.234) === '$1.23');

    const log = new ActivityLog(adir, LA);
    // 23:30 PST on the 14th and 00:30 PST on the 15th land in different files.
    log.record({ at: '2026-11-15T07:30:00Z', kind: 'reply', outcome: 'ok', channel: 'food', ask: 'save tartine to dessert', tools: ['places_add'], usage: { ...noUsage('claude-haiku-5-5'), input: 20_000 } });
    log.record({ at: '2026-11-15T08:30:00Z', kind: 'reply', outcome: 'error', channel: 'travel', ask: 'what time is my flight', error: 'overloaded', messageId: '123' });
    const trace = newTrace();
    traceTools(trace, [{ name: 'fetch_page', content: 'HTTP 403 Forbidden', isError: true }, { name: 'recall', content: 'ok' }]);
    log.record({ at: '2026-11-15T09:00:00Z', kind: 'reply', outcome: 'ok', channel: 'food', ask: 'open the maangchi recipe', voice: true, tools: trace.tools });
    log.record({ at: '2026-11-15T10:00:00Z', kind: 'task', outcome: 'ok', title: 'Kyoto hotels', calls: 12, usage: { ...noUsage('claude-sonnet-5-5'), input: 200_000, output: 20_000 } });
    const files = (await import('node:fs')).readdirSync(adir).sort().join(',');
    check('activity: one file per local day', files === '2026-11-14.jsonl,2026-11-15.jsonl', files);
    const back = log.read(new Date('2026-11-15T08:00:00Z'), new Date('2026-11-16T00:00:00Z'));
    check('activity: reads back a window, oldest first', back.map((e) => e.channel ?? e.kind).join(',') === 'travel,food,task', back.map((e) => e.channel ?? e.kind).join(','));
    check('activity: cost is stored with each event', (back.find((e) => e.kind === 'task')?.costUsd ?? 0) > 0.5);
    check('activity: a failed tool keeps its error', trace.tools.join('|') === 'fetch_page: HTTP 403 Forbidden|recall', trace.tools.join('|'));
    log.prune(new Date('2027-06-01T00:00:00Z'));
    check('activity: old days are pruned', (await import('node:fs')).readdirSync(adir).length === 0);

    const all = [...back, { at: '2026-11-15T07:30:00Z', kind: 'reply' as const, outcome: 'ok', channel: 'food', ask: 'save tartine', costUsd: 0.002 }];
    const usage = usageSummary(all, LA, 7);
    check('/usage: total, per day and priciest', usage.includes('last 7 days') && usage.includes('2026-11-15') && usage.includes('task "Kyoto hotels"'), usage);
    const digest = reviewDigest(
      [{ id: 'j1', channelId: 'c', channelName: 'travel', from: '2026-11-15T08:00:00Z', to: '2026-11-15T08:40:00Z', summary: 'Flight check: asked for the UA123 time twice.' }],
      back,
      LA,
      new Date('2026-11-15T06:00:00Z'),
    );
    const problemsAt = digest.indexOf('Problems: 2');
    check('digest: journal first, then problems, then asks', digest.indexOf('Journal: 1') < problemsAt && problemsAt < digest.indexOf('Asks, in order'), digest);
    check('digest: names the failed tool and the message', digest.includes('failed tools: fetch_page: HTTP 403') && digest.includes('message 123'), digest);
    check('digest: voice notes are marked', digest.includes('🎤'), digest);

    process.env.VOICE_FILE = join(adir, 'voice.json');
    check('voice: an untranscribed note says so', voiceLine({ id: 'v0', contentType: 'audio/ogg', name: 'voice-message.ogg', duration: 12 }) === '[voice note 0:12]');
    rememberTranscript('v1', 'remind me to call mom at six');
    const said = messageText({ content: '', attachments: new Map([['v1', { id: 'v1', contentType: 'audio/ogg', name: 'voice-message.ogg', duration: 4.2 }]]) as never, embeds: [], createdAt: new Date() }, LA);
    check('voice: a transcribed note becomes the message text', said === '[voice note 0:04: "remind me to call mom at six"]', said);

    const state = new BriefState(join(adir, 'brief.json'));
    const nineAm = new Date('2026-11-15T17:00:00Z');
    check('brief: due after the hour, once a day', !state.due(new Date('2026-11-15T15:00:00Z'), LA, 8) && state.due(nineAm, LA, 8));
    state.sent(nineAm, LA);
    check('brief: not sent twice, even after a restart', !new BriefState(join(adir, 'brief.json')).due(new Date('2026-11-15T18:00:00Z'), LA, 8));
    const chState = new BriefState(join(adir, 'ch.json'));
    const chans = [{ id: '1', name: 'travel' }, { id: '2', name: 'misc' }];
    check('brief: goes to #misc, kept by ID', briefChannel(chState, undefined, chans) === '2' && briefChannel(new BriefState(join(adir, 'ch.json')), undefined, [{ id: '1', name: 'travel' }, { id: '2', name: 'squire' }]) === '2');
    check('brief: a configured channel wins', briefChannel(chState, '9', chans) === '9');
    check('brief: not sent in the afternoon', !new BriefState(join(adir, 'none.json')).due(new Date('2026-11-15T23:30:00Z'), LA, 8));
    const rs = new ReminderStore(join(adir, 'r.json'), LA);
    rs.add({ text: 'Pick up dry cleaning', due: new Date('2026-11-15T20:00:00Z'), repeat: 'none', channelId: 'c' }, nineAm);
    rs.add({ text: 'Not today', due: new Date('2026-11-17T20:00:00Z'), repeat: 'none', channelId: 'c' }, nineAm);
    const bj = new Journal(join(adir, 'j.json'));
    bj.done('c', '1', { channelId: 'c', channelName: 'travel', from: '2026-11-14T08:00:00Z', to: '2026-11-14T09:00:00Z', summary: 'Japan trip: still need to book the Osaka hotel.', ongoing: { until: '2027-06-12', topic: 'Japan trip' } });
    const facts = await briefFacts({ timeZone: LA, reminders: rs, journal: bj, tasks: { active: () => [] } as never }, nineAm);
    check('brief: facts carry today, reminders and open plans', facts.includes('Sunday, November 15') && facts.includes('Pick up dry cleaning') && !facts.includes('Not today') && facts.includes('Osaka hotel') && !facts.includes('work-city forecast'), facts);
    const monday = await briefFacts({ timeZone: LA, reminders: rs, journal: bj, tasks: { active: () => [] } as never }, new Date('2026-11-16T17:00:00Z'));
    const handoff = dropMissingNotes('* Hand off to @alex at the card shop (time not set yet): purple Riven AA\n* the card shop handoff to @alex today, no time set: red Pyke AA\n* Dinner — time TBD.\n* No time set? Fine.');
    check('brief: notes about missing details are taken out', handoff === '* Hand off to @alex at the card shop: purple Riven AA\n* the card shop handoff to @alex today: red Pyke AA\n* Dinner.\n* No time set? Fine.', handoff);
    const mailbox = (name: string) =>
      ({ name, api: async (url: string) => (url.endsWith('/messages') ? { messages: [{ id: 'm' }] } : url.includes('/messages/') ? { id: 'm', snippet: `${name} bill due`, payload: { mimeType: 'text/plain', headers: [], body: { data: Buffer.from(`${name}: payment due on Nov 20`).toString('base64url') } } } : { items: [] }) }) as never;
    const workBox = mailbox('work');
    const mainBox = { ...(mailbox('main') as object), extraMail: [workBox], mailboxes: () => [mainBox, workBox] } as never;
    const twoInboxes = await briefFacts({ timeZone: LA, reminders: rs, journal: bj, tasks: { active: () => [] } as never, google: mainBox }, nineAm);
    check('brief: every Gmail account gets its own inbox facts, with the email text', twoInboxes.includes('Inbox (main account)') && twoInboxes.includes('Inbox (work account)') && twoInboxes.includes('work: payment due on Nov 20'), twoInboxes);
    check('brief: on a weekday it asks for the work-city forecast', monday.includes('work-city forecast'), monday);

    // A reply's trace: calls, tools and usage add up across rounds.
    const replies = [
      { stop: 'tool_use' as const, text: '', calls: [{ id: 'a', name: 'recall', input: { query: 'x' } }], sources: new Sources(), turn: { role: 'assistant' as const, text: '', calls: [{ id: 'a', name: 'recall', input: { query: 'x' } }] }, usage: { ...noUsage('claude-haiku-5-5'), input: 100 } },
      { stop: 'done' as const, text: 'done', calls: [], sources: new Sources(), turn: { role: 'assistant' as const, text: 'done' }, usage: { ...noUsage('claude-haiku-5-5'), input: 50, webSearches: 1 } },
    ];
    const agent = new Agent({ llm: { retryable: () => false, generate: async () => replies.shift()! }, model: 'claude-haiku-5-5', effort: 'low', timeZone: LA, reminders: rs, journal: bj });
    const replyTrace = newTrace();
    await agent.reply([{ role: 'user', content: [{ type: 'text', text: 'hm' }] }], { channelId: 'c', channelName: 'misc', trace: replyTrace });
    check('agent: the trace counts calls, tools and usage', replyTrace.calls === 2 && replyTrace.tools.join() === 'recall' && replyTrace.usage?.input === 150 && replyTrace.usage.webSearches === 1, JSON.stringify(replyTrace));
    // "Got it, from now on…" with nothing saved goes back once to save it.
    const reply = (t: string) => ({ stop: 'done' as const, text: t, calls: [], sources: new Sources(), turn: { role: 'assistant' as const, text: t } });
    const saveCall = { id: 's', name: 'remember', input: { text: 'Prefers aisle seats' } };
    const promiseMem = new MemoryStore(join(adir, 'promise-mem.json'));
    const scripted = [reply('Got it. From now on I will book aisle seats.'), { stop: 'tool_use' as const, text: '', calls: [saveCall], sources: new Sources(), turn: { role: 'assistant' as const, text: '', calls: [saveCall] } }, reply('Got it, aisle seats from now on.')];
    const seen: string[] = [];
    const promiser = new Agent({
      llm: { retryable: () => false, generate: async (_m: unknown, req: { turns: { role: string; content?: { text?: string }[] }[] }) => (seen.push(JSON.stringify(req.turns.at(-1))), scripted.shift()!) },
      model: 'claude-haiku-5-5', effort: 'low', timeZone: LA, reminders: rs, memory: promiseMem,
    } as never);
    const promised = await promiser.reply([{ role: 'user', content: [{ type: 'text', text: 'always book me aisle seats' }] }], { channelId: 'c', channelName: 'travel' });
    check('agent: an unsaved "from now on" is sent back to be saved', promiseMem.list().some((m) => m.text === 'Prefers aisle seats') && promised.startsWith('Got it, aisle') && seen.some((t) => t.includes('saved nothing to memory')), `${promised} | ${seen.join(' / ')}`);
    const plain = [reply('Sure, here are three cafes.')];
    const quiet = new Agent({ llm: { retryable: () => false, generate: async () => plain.shift()! }, model: 'claude-haiku-5-5', effort: 'low', timeZone: LA, reminders: rs, memory: promiseMem } as never);
    check('agent: an ordinary reply is not sent back', (await quiet.reply([{ role: 'user', content: [{ type: 'text', text: 'cafes?' }] }], { channelId: 'c', channelName: 'misc' })).startsWith('Sure'));
  } finally {
    rmSync(adir, { recursive: true, force: true });
  }
}

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nAll assistant checks passed');
