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
import { captionText, describeVideo, pickCaptions, readVideo, tiktokSlides, videoTools } from './video.js';
import { cleanTranscript } from './transcribe.js';
import { TaskRunner, TaskStore } from './tasks.js';
import { profilePrompt, Sources, type Generation, type GenerateRequest, type LLM, type ModelOptions, type ToolCall, type Turn } from './llm.js';
import { fromMessage, limitStrict, MAX_STRICT_TOOLS, toMessages, webTools } from './anthropic.js';
import { MemoryStore } from './memory.js';
import { notesTools } from './notes.js';
import { trainingTools } from './trainingTools.js';
import { TrainingService } from '../training/service.js';
import { PlanStore } from '../training/store.js';
import { Vault } from '../../vault.js';
import { isOpenAt, mapsLink, parseListResponse, SavedPlaces, todaysHours, type PlaceDetails } from './places.js';
import { placesTools } from './placesTools.js';

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
  // A follow-up about a screenshot sent a minute ago needs the screenshot
  // still visible to the model.
  const shot = { url: 'https://cdn/s.jpg', contentType: 'image/jpeg', name: 's.jpg' };
  const imageCount = (t: Turn[]) => t.flatMap((x) => (x.role === 'user' ? x.content : [])).filter((b) => b.type === 'image').length;
  const recentShot = buildConversation([{ ...l('1', 'me', '', 0), attachments: [shot] }, l('2', 'bot', 'Got it.', 30, '1'), l('3', 'me', 'open the link in it', 90)], opts);
  check('a screenshot from a minute ago is still shown', imageCount(recentShot) === 1, String(imageCount(recentShot)));
  const oldShot = buildConversation([{ ...l('1', 'me', '', 0), attachments: [shot] }, l('2', 'bot', 'Got it.', 30, '1'), l('3', 'me', 'thanks', 3600)], opts);
  check('an answered screenshot from an hour ago is only named', imageCount(oldShot) === 0, String(imageCount(oldShot)));
  // A task report that pings the owner has to read as the task's own post,
  // or the assistant takes it for an unsourced reply of its own.
  const pinged = buildConversation([l('1', 'me', 'find amounts', 0), l('2', 'bot', '<@123> ✅ **Recipe amounts** — done', 60), l('3', 'me', 'save it', 70)], opts);
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
    const posts: { channelId: string; content: string; ping: boolean }[] = [];
    const tfile = join(tdir, 'tasks.json');
    const rstore = new ReminderStore(join(tdir, 'r.json'), LA);
    const vault = new Vault(tdir);
    const fake: LLM = {
      retryable: () => false,
      async generate(model: ModelOptions, req: GenerateRequest) {
        seen.push(structuredClone(req.turns));
        models.push(model.model);
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
  const payload = `)]}'\n${JSON.stringify([[null, null, null, null, 'Dessert', null, null, null, [entry('Corner Bakery', '600 Guerrero St, SF', 37.7614, -122.4241, 'morning bun'), entry('Scoop Shop', '3692 18th St, SF', 37.7616, -122.4257)]]])}`;
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
      { key: 'c1', list: 'Dessert', name: 'Corner Bakery', location: { lat: 37.7614, lng: -122.4241 }, note: 'morning bun', source: 'list', details: hours },
      { key: 'c2', list: 'Dessert', name: 'Scoop Shop', location: { lat: 37.7616, lng: -122.4257 }, source: 'list' },
      { key: 'c3', list: 'Bars', name: 'Night Owl', location: { lat: 37.759, lng: -122.4114 }, source: 'list', details: { ...hours, periods: [] } },
      { key: 'chat-1', list: 'Dessert', name: 'Cocoa House', location: { lat: 37.7609, lng: -122.4214 }, source: 'chat' },
    ];
    // "home" and a named area resolve from the remembered geocodes; no API here.
    places.store.data.geocodes['central park'] = { lat: 37.7598, lng: -122.4271, label: 'Central Park' };
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
    check('a list prefix picks the list', dessert.includes('Corner Bakery') && !dessert.includes('Night Owl'), dessert);
    check('the owner\'s note is searchable', (await find({ text: 'bun' })).startsWith('Corner Bakery'));
    const near = await find({ near: 'Central Park', within_km: 0.4 });
    check('near a place: nearest first, radius applied', near.split('\n')[1]?.startsWith('Scoop Shop') === true && !near.includes('Night Owl'), near);
    const open = await find({ open_now: true });
    check('open now keeps only known-open spots and counts the unknown', open.includes('Corner Bakery') && !open.includes('Scoop Shop') && open.includes('3 matching places left out'), open);
    check('removing a Google list entry is refused', fail('places_remove', { key: 'c1' }).includes('remove it there'));
    await tools.get('places_remove')!.run({ key: 'chat-1' });
    check('a chat-added place can be removed', !new SavedPlaces({ file: join(pdir, 'places.json'), listUrls: [] }).places().some((p) => p.key === 'chat-1'));
    // A match far from the area asked for is probably a namesake elsewhere.
    const here = { lat: 40, lng: -100 };
    const fakeHit = (name: string, location: { lat: number; lng: number }) => ({ name, address: name, location, details: { placeId: name, fetchedAt: '' } });
    const withApi = places as unknown as { api?: { find: (q: string) => Promise<unknown> } };
    withApi.api = { find: async (q) => (q.startsWith('Far') ? fakeHit('Far Cafe', { lat: 41.5, lng: -90 }) : fakeHit('Near Cafe', { lat: 40.01, lng: -100.01 })) };
    const farMatch = await places.add('Bars', 'Far Cafe', here).then(() => '', (err: Error) => err.message);
    check('a match far from the area asked for is not saved', farMatch.startsWith('Not saved') && !places.places().some((p) => p.name.includes('Far')), farMatch);
    const nearMatch = await places.add('Bars', 'Near Cafe', here);
    check('a match in the area asked for is saved', nearMatch.name === 'Near Cafe');
    withApi.api = undefined;
    let noKey = '';
    await places.add('Dessert', 'Mitchell\'s Ice Cream', undefined).catch((err: Error) => (noKey = err.message));
    check('adding without an API key says what is missing', noKey.includes('GOOGLE_MAPS_API_KEY'), noKey);
  } finally {
    rmSync(pdir, { recursive: true, force: true });
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

    // Organising Squire: folders, moves, renames, trash.
    await call('save_note', { title: 'Japan trip bookings', content: '- Tokyo stay booked', mode: 'create', folder: '' });
    const moved = await call('move_note', { from: 'Inbox/Japan trip bookings.md', to: 'Travel/Japan' });
    check('a note moved onto a new folder keeps its name', vault.read('Squire/Travel/Japan/Japan trip bookings.md')?.includes('Tokyo') === true && !vault.read('Squire/Inbox/Japan trip bookings.md'), moved);
    await call('save_note', { title: 'Osaka', content: '- to book', mode: 'create', folder: 'Squire/Travel/Japan' });
    check('save writes into a named folder', vault.read('Squire/Travel/Japan/Osaka.md')?.includes('to book') === true);
    const tree = await call('list_notes', { folder: 'Travel' });
    check('list shows subfolders and notes', tree.includes('Squire/Travel/Japan/') && tree.includes('Squire/Travel/Japan/Osaka.md'), tree);
    await call('move_note', { from: 'Travel', to: 'Trips' });
    check('a whole folder can be renamed', vault.list('Squire/Trips').length === 2 && vault.list('Squire/Travel').length === 0);
    check('move refuses to overwrite', (await fail('move_note', { from: 'Trips/Japan/Osaka.md', to: 'Trips/Japan/Japan trip bookings.md' })).includes('already exists'));
    check('move refuses to leave Squire', (await fail('move_note', { from: 'Trips/Japan/Osaka.md', to: '../notes/Osaka.md' })).includes('".."'));
    vault.write('Squire/Training/log.md', 'x');
    check('the training log is off limits', (await fail('move_note', { from: 'Training/log.md', to: 'Inbox' })).includes('training'));
    check('saving into the training log is refused', (await fail('save_note', { title: 'x', content: 'x', mode: 'create', folder: 'Training' })).includes('training'));
    await call('delete_note', { path: 'Trips/Japan/Osaka.md' });
    check('delete puts the note in Obsidian\'s trash', vault.read('.trash/Osaka.md')?.includes('to book') === true && !vault.read('Squire/Trips/Japan/Osaka.md'));
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

  const recipePage = `<html><head><title>Beef Stew &amp; more</title>
    <script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"WebPage"},{"@type":["Recipe"],"name":"Beef stew","recipeYield":["4"],
    "recipeIngredient":["2 pounds beef short ribs","&frac13; cup soy sauce"],
    "recipeInstructions":[{"@type":"HowToSection","name":"Ribs","itemListElement":[{"@type":"HowToStep","text":"Soak the ribs."},{"@type":"HowToStep","text":"Blanch them."}]}]}]}</script>
    </head><body><nav>Home | Recipes</nav><script>var x = 1;</script><h1>Beef stew</h1><p>Braised short ribs.</p><ul><li>one</li><li>two</li></ul></body></html>`;
  const recipe = recipeFromHtml(recipePage);
  check('a recipe is read from structured data', !!recipe && recipe.includes('Recipe: Beef stew') && recipe.includes('- 2 pounds beef short ribs') && recipe.includes('Ribs:') && recipe.includes('2. Soak the ribs.'), recipe);
  const page = await fetchPage('https://recipes.example/stew', routes({ 'https://recipes.example/stew': () => reply(200, recipePage, { 'content-type': 'text/html; charset=utf-8' }) }), open);
  check('a page comes back as title, recipe and text', page.includes('Title: Beef Stew & more') && page.includes('Recipe: Beef stew') && page.includes('Braised short ribs.') && page.includes('- one') && !page.includes('var x') && !page.includes('Home | Recipes'), page);
  const blocked = await why(fetchPage('https://recipes.example/x', routes({ 'https://recipes.example/x': () => reply(403, '<title>Attention Required! | Cloudflare</title>', { 'content-type': 'text/html', server: 'cloudflare' }) }), open));
  check('a bot check is reported plainly', blocked.includes('bot check') && blocked.includes('screenshot'), blocked);

  const names = (tools: ReturnType<typeof linkTools>) => tools.map((t) => t.def.name).join(',');
  check('without Discord there is only fetch_page', names(linkTools()) === 'fetch_page');
  const reads: { channelId: string; messageId?: string; count: number }[] = [];
  const withDiscord = linkTools({ read: async (link, count) => (reads.push({ ...link, count }), { content: 'ok', images: [] }) });
  await withDiscord[1]!.run({ link: 'https://discord.com/channels/1/2/3', count: 500 });
  check('read_discord_messages caps the count', reads[0]?.messageId === '3' && reads[0].count === 100, JSON.stringify(reads));
  check('fetch_page sends Discord links to the other tool', (await why(Promise.resolve().then(() => withDiscord[0]!.run({ url: 'https://discord.com/channels/1/2/3' })))).includes('read_discord_messages'));
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
  // TikTok photo posts carry their slides and caption in the page data.
  const ttPage = `<html><script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify({
    __DEFAULT_SCOPE__: { 'webapp.video-detail': { itemInfo: { itemStruct: { desc: '#cafes', author: { uniqueId: 'someone' }, imagePost: { images: [{ imageURL: { urlList: ['https://p16.tiktokcdn-us.com/a.jpeg', 'https://p19.tiktokcdn-us.com/a.jpeg'] } }, { imageURL: { urlList: ['https://p16.tiktokcdn-us.com/b.jpeg'] } }] } } } } },
  })}</script></html>`;
  const slides = tiktokSlides(ttPage);
  check('a TikTok photo post reads as its slides and caption', slides?.images.join(',') === 'https://p16.tiktokcdn-us.com/a.jpeg,https://p16.tiktokcdn-us.com/b.jpeg' && slides.caption === '#cafes' && slides.author === 'someone', JSON.stringify(slides));
  check('a TikTok page without slides gives nothing', tiktokSlides('<html><script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">{"__DEFAULT_SCOPE__":{}}</script></html>') === undefined);
  check('a transcript of only sound tags means no speech', cleanTranscript(' Music') === '' && cleanTranscript('[Music] ♪ (applause)') === '' && cleanTranscript(' you') === '');
  const looped = cleanTranscript('오늘의 요리는! 물을 끓여줍니다. 고추장 양파 고추장, 고추장, 고추장, 고추장, 고추장, 고추장, 고추장, 고추장');
  check('a word Whisper loops on is collapsed', looped === '오늘의 요리는! 물을 끓여줍니다. 고추장 양파 고추장 [repeated]', looped);
  const real = 'add 1 tablespoon of soy sauce and 1 tablespoon of sugar';
  check('ordinary repeats are kept', cleanTranscript(real) === real && cleanTranscript('[Music] Add the flour.') === 'Add the flour.');
  check('the video tool refuses Discord links', (await Promise.resolve().then(() => videoTools()[0]!.run({ url: 'https://discord.com/channels/1/2/3' })).then(() => '', (e: Error) => e.message)).includes('read_discord_messages'));
  check('nothing on the local network is opened as a video', (await readVideo('http://192.168.1.10/cam').then(() => '', (e: Error) => e.message)).includes('private'));
}

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nAll assistant checks passed');
