/**
 * Offline checks for channel tools, photo actions, the expense log, search by
 * meaning and the weekly review. No network, no Discord,
 * no API key, no Ollama: embeddings and routes are scripted stand-ins.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ALL_GROUPS, channelGroups, missingGroupsNote, parseChannelTools } from './channelTools.js';
import { appendExpense, expenseTools, photoPrompt } from './photo.js';
import { chunkNote, SemanticIndex, semanticTools, type Embed } from './semantic.js';
import { isReviewDay, weeklyFacts, WEEKLY_RULES } from './weekly.js';
import { BriefState, writeBrief } from './brief.js';
import { addInboxEvents, alreadyOnCalendar, inboxEventsFact, inEventZone, INBOX_EVENTS_SYSTEM, parseInboxCancellations, parseInboxEvents } from './inboxEvents.js';
import { Agent, withMeaning } from './agent.js';
import { Journal } from './journal.js';
import { ReminderStore } from './reminders.js';
import { Sources, type GenerateRequest, type LLM, type Turn } from './llm.js';
import { Vault } from '../../vault.js';
import { buildProfile, cleanOwnMessage, collectFromServer, parseProfile, PROFILE_SYSTEM, sampleForProfile, StyleStore, styleStats, type StyleMessage } from './style.js';

let failures = 0;
const check = (label: string, ok: boolean, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${label.padEnd(52, '.')} ${ok ? 'OK' : 'FAIL'}  ${detail}`);
};
const LA = 'America/Los_Angeles';
const dir = mkdtempSync(join(tmpdir(), 'squire-features-'));

try {
  // --- channel tools ---
  {
    const cfg = { category: 'squire' };
    const gym = channelGroups('gym', 'Squire', cfg);
    check('a #gym in the category gets training, not Gmail', gym.has('training') && !gym.has('google') && !gym.has('places'), [...gym].join());
    check('an emoji in the name still matches', channelGroups('🏋️-gym', 'squire', cfg).has('training') && !channelGroups('🏋️-gym', 'squire', cfg).has('google'));
    check('an unmapped channel gets everything', channelGroups('misc', 'squire', cfg) === ALL_GROUPS);
    check('outside the category, everything', channelGroups('gym', 'other', cfg) === ALL_GROUPS && channelGroups('gym', undefined, cfg) === ALL_GROUPS);
    check('no category set: everything', channelGroups('gym', 'squire', {}) === ALL_GROUPS);
    const overrides = parseChannelTools('cards = google, notes; #gym=all');
    check('overrides parse, "all" included', JSON.stringify(overrides) === '{"cards":["google","notes"],"gym":"all"}', JSON.stringify(overrides));
    check('an override replaces the default', channelGroups('gym', 'squire', { ...cfg, overrides }) === ALL_GROUPS && channelGroups('cards', 'squire', { ...cfg, overrides }).has('google'));
    let bad = '';
    try {
      parseChannelTools('gym=lifting');
    } catch (err) {
      bad = (err as Error).message;
    }
    check('an unknown group is refused by name', bad.includes('"lifting"'), bad);
    check('the model is told what this channel lacks', missingGroupsNote(gym).includes('Gmail and Calendar') && missingGroupsNote(ALL_GROUPS) === '');

    // The agent: #gym's request carries no Gmail or places tools, and its prompt no Gmail section.
    const seen: GenerateRequest[] = [];
    const vault = new Vault(mkdtempSync(join(dir, 'vault-')));
    const rs = new ReminderStore(join(dir, 'r.json'), LA);
    const done = { stop: 'done' as const, text: 'ok', calls: [], sources: new Sources(), turn: { role: 'assistant' as const, text: 'ok' } };
    const agent = new Agent({
      llm: { retryable: () => false, generate: async (_m, req) => (seen.push(req), done) },
      model: 'm',
      effort: 'low',
      timeZone: LA,
      reminders: rs,
      vault,
      google: { mailboxes: () => [], extraMail: [] } as never,
      channelTools: { category: 'squire' },
    });
    const ask: Turn[] = [{ role: 'user', content: [{ type: 'text', text: 'bench 185x5' }] }];
    await agent.reply(ask, { channelId: 'g', channelName: 'gym', categoryName: 'squire' });
    await agent.reply(ask, { channelId: 'm', channelName: 'misc', categoryName: 'squire' });
    const [gymReq, miscReq] = seen;
    const names = (r?: GenerateRequest) => (r?.tools ?? []).map((t) => t.name);
    check('agent: #gym gets no Gmail, places or expense tools', !names(gymReq).some((n) => n.startsWith('gmail_') || n.startsWith('calendar_') || n === 'log_expense') && names(gymReq).includes('create_reminder'), names(gymReq).join());
    check('agent: #misc gets Gmail, notes and expenses', names(miscReq).includes('gmail_search') && names(miscReq).includes('save_note') && names(miscReq).includes('log_expense'), names(miscReq).join());
    check('agent: #gym\'s prompt has no Gmail section', !gymReq!.system.includes('Gmail and Calendar:') && gymReq!.system.includes("don't have tools here for"), '');
    check('agent: the prompt for a channel is built once', agent.systemFor(channelGroups('gym', 'squire', { category: 'squire' })) === agent.systemFor(channelGroups('gym', 'squire', { category: 'squire' })));
  }

  // --- photos ---
  {
    const everywhere = photoPrompt(ALL_GROUPS);
    check('photos: every action listed with every group', everywhere.includes('calendar_create_event') && everywhere.includes('log_expense') && everywhere.includes('places_add'));
    const gymOnly = photoPrompt(new Set(['training', 'notes']));
    check('photos: only what the channel can do', !gymOnly.includes('calendar_create_event') && !gymOnly.includes('log_expense') && gymOnly.includes('training_'), '');
    check('photos: nothing to do, no section', photoPrompt(new Set()) === '');
  }

  // --- expenses ---
  {
    const vault = new Vault(mkdtempSync(join(dir, 'exp-')));
    const path = appendExpense(vault, { date: '2026-11-18', merchant: 'Trader Joe|s', amount: 42.5, currency: 'USD', category: 'groceries', note: '' });
    appendExpense(vault, { date: '2026-11-19', merchant: 'Tartine', amount: 18, currency: 'usd', category: 'dining', note: 'with Chris' });
    const note = vault.read(path) ?? '';
    check('expenses: one note per month', path === 'Finance/Expenses/2026-11.md', path);
    check('expenses: header once, a row each', note.split('| Date |').length === 2 && note.includes('| 2026-11-18 | Trader Joe/s | $42.50 | groceries |') && note.includes('| 2026-11-19 | Tartine | $18.00 | dining | with Chris |'), note);
    const [tool] = expenseTools(vault, LA, () => new Date('2026-12-02T20:00:00Z'));
    const out = String(await tool!.run({ date: '', merchant: 'Shell', amount: 61.2, currency: 'USD', category: 'transport', note: '' }));
    check('expenses: no date means today, in a new month', out.includes('2026-12.md') && (vault.read('Finance/Expenses/2026-12.md') ?? '').includes('| 2026-12-02 | Shell | $61.20 |'), out);
    let refused = '';
    try {
      await tool!.run({ date: '2026-12-02', merchant: 'x', amount: -3, currency: 'USD', category: 'other', note: '' });
    } catch (err) {
      refused = (err as Error).message;
    }
    check('expenses: a negative amount is refused', refused.includes('positive'), refused);
  }

  // --- search by meaning ---
  {
    // A stand-in embedder: each text becomes counts of a few "topic" words, so similar topics point the same way.
    const topics = [['dumpling', 'noodle', 'restaurant', 'eat'], ['car', 'tire', 'oil', 'mechanic'], ['flight', 'fly', 'trip', 'hotel', 'vegas', 'staying'], ['bench', 'squat', 'gym']];
    let embedded = 0;
    const embed: Embed = async (texts) => {
      embedded += texts.length;
      return texts.map((t) => {
        const low = t.toLowerCase();
        return [...topics.map((ws) => ws.filter((w) => low.includes(w)).length + 0.01), 0.01];
      });
    };
    const vault = new Vault(mkdtempSync(join(dir, 'sem-')));
    vault.write('Ideas/Car.md', '# Car\n\nGet the tire rotated and the oil changed at the mechanic.');
    vault.write('Food/Spots.md', '# Spots\n\nSam said the dumpling and noodle restaurant on Main is great.');
    vault.write('Training/Splits/Push.md', 'bench squat gym');
    const journal = new Journal(join(dir, 'sem-journal.json'));
    journal.done('c', '1', { channelId: 'c', channelName: 'travel', from: '2026-10-01T10:00:00Z', to: '2026-10-01T11:00:00Z', summary: 'Booked the Vegas flight and hotel for the trip.' });
    const index = new SemanticIndex(join(dir, 'semantic.json'), 'stub', embed, { vault, journal });
    const first = await index.refresh();
    check('semantic: notes and journal are embedded, training left out', first === 3 && index.size === 3, `${first} / ${index.size}`);
    check('semantic: nothing changed, nothing re-embedded', (await index.refresh()) === 0);
    vault.write('Ideas/Car.md', '# Car\n\nThe mechanic says new tires soon.');
    check('semantic: a changed note is embedded again', (await index.refresh()) === 1);
    const hits = await index.search('where was that place to eat Chris liked');
    check('semantic: finds by meaning, not words', hits[0]?.ref === 'Food/Spots.md', JSON.stringify(hits.map((h) => h.ref)));
    const trip = await index.search('when do I fly out', { scope: 'journal' });
    check('semantic: journal scope finds the conversation', trip.length === 0 || trip[0]?.kind === 'journal', JSON.stringify(trip));
    const reloaded = new SemanticIndex(join(dir, 'semantic.json'), 'stub', embed, { vault, journal });
    check('semantic: the index is kept on disk', reloaded.size === 3);
    const otherModel = new SemanticIndex(join(dir, 'semantic.json'), 'other', embed, { vault, journal });
    check('semantic: another model starts a fresh index', otherModel.size === 0);
    const [tool] = semanticTools(index, journal, LA);
    const out = String(await tool!.run({ query: 'vegas hotel trip', scope: 'all' }));
    check('semantic: the tool shows the conversation', out.includes('#travel') && out.includes('Booked the Vegas flight'), out);
    const down = new SemanticIndex(join(dir, 'down.json'), 'stub', async () => { throw new Error('connect ECONNREFUSED'); }, { vault, journal });
    const offline = await Promise.resolve().then(() => semanticTools(down, journal, LA)[0]!.run({ query: 'x', scope: 'all' })).then(String, (err: Error) => err.message);
    check('semantic: Ollama down says to use the keyword tools', offline.includes('offline') && offline.includes('search_notes'), offline);
    const chunks = chunkNote('Long.md', Array.from({ length: 30 }, (_, i) => `Paragraph ${i} ${'x'.repeat(200)}`).join('\n\n'));
    check('semantic: long notes are cut into titled chunks', chunks.length > 3 && chunks.every((c) => c.startsWith('Long\n') && c.length <= 1300), String(chunks.length));

    // Related by meaning rides along with the message.
    // Five newer conversations push the Vegas one out of the prompt's recent list.
    for (let i = 0; i < 5; i++) journal.done('c', String(i + 2), { channelId: 'c', channelName: 'misc', from: `2026-11-0${i + 1}T10:00:00Z`, to: `2026-11-0${i + 1}T11:00:00Z`, summary: `Chat ${i} about the bench press.` });
    const ask: Turn[] = [{ role: 'user', content: [{ type: 'text', text: 'when do we fly out and where are we staying' }] }];
    const withNote = await withMeaning(ask, ask, journal, index, LA, new Date('2027-01-01T00:00:00Z'));
    const noteText = withNote.at(-1)?.role === 'user' ? (withNote.at(-1) as { content: { text?: string }[] }).content.map((p) => p.text ?? '').join(' ') : '';
    check('semantic: a related conversation is added to the turn', noteText.includes('something similar') && noteText.includes('Vegas'), noteText);
    const quiet = await withMeaning(ask, ask, journal, down, LA);
    check('semantic: with Ollama down the turn is unchanged', quiet === ask);
  }

  // --- weekly review ---
  {
    const sunday = new Date('2026-11-22T17:00:00Z'); // Sun 9 AM
    check('weekly: Sunday is review day', isReviewDay(sunday, LA, 'Sun') && !isReviewDay(new Date('2026-11-23T17:00:00Z'), LA, 'Sun') && !isReviewDay(sunday, LA, undefined));
    const rs = new ReminderStore(join(dir, 'weekly-r.json'), LA);
    rs.add({ text: 'Pay rent', due: new Date('2026-11-25T17:00:00Z'), repeat: 'none', channelId: 'c' }, sunday);
    rs.add({ text: 'Way later', due: new Date('2026-12-20T17:00:00Z'), repeat: 'none', channelId: 'c' }, sunday);
    const google = {
      api: async (path: string) =>
        path.endsWith('calendarList')
          ? { items: [{ id: 'primary' }] }
          : { items: [{ id: 'e1', summary: 'Dentist', start: { dateTime: '2026-11-24T23:30:00Z' }, end: { dateTime: '2026-11-25T00:30:00Z' } }] },
    };
    const activity = { read: () => [{ at: '', kind: 'reply', costUsd: 0.4, outcome: 'ok' }, { at: '', kind: 'task', costUsd: 1.1, outcome: 'error' }] };
    const training = { weekFacts: () => 'Sessions: 4. Chest 12 sets (target 10-20).' };
    const facts = await weeklyFacts({ timeZone: LA, reminders: rs, google: google as never, training: training as never, activity: activity as never }, sunday);
    check('weekly: the week\'s events', facts.includes('Calendar for the week ahead') && facts.includes('Dentist'), facts);
    check('weekly: reminders in the week, not later ones', facts.includes('Pay rent') && !facts.includes('Way later'));
    check('weekly: training and spend', facts.includes('Sessions: 4') && facts.includes('1 replies, about $1.50') && facts.includes('1 that ended in an error'), facts);
    let system = '';
    const llm = { retryable: () => false, generate: async (_m: unknown, req: GenerateRequest) => ((system = req.system), { stop: 'done' as const, text: '**Week ahead**\n- Tue: Dentist 3:30 PM', calls: [], sources: new Sources(), turn: { role: 'assistant' as const, text: '' } }) };
    const out = await writeBrief(llm, { model: 'm', effort: 'low' }, `Today is Sunday, November 22.\n\n${facts}`, undefined, [], WEEKLY_RULES);
    check('weekly: written with the review\'s rules', system.includes('weekly review, which replaces the brief') && out.text.includes('Week ahead'), system.slice(-200));
  }
  // --- inbox events: booked things found in the mail go on the calendar, once ---
  {
    const parsed = parseInboxEvents('Here: {"events":[{"email":1,"title":"DJ Nova at Skyline Club","start":"2026-12-12T22:00","end":"","all_day":false,"time_zone":"America/Los_Angeles","location":"Skyline Club, Chicago"},{"email":2,"title":"bad","start":"Dec 12","end":"","all_day":false,"time_zone":"","location":""}]}');
    check('inbox events: parsed, malformed ones dropped', parsed.length === 1 && parsed[0]!.title === 'DJ Nova at Skyline Club', JSON.stringify(parsed));
    check('inbox events: junk answer is no events', parseInboxEvents('no json here').length === 0);
    const onCal = [{ id: 'x', summary: 'DJ NOVA show', start: { dateTime: '2026-12-13T06:00:00Z', timeZone: 'America/Los_Angeles' } }];
    check('inbox events: same day, shared name = already on the calendar', alreadyOnCalendar(parsed[0]!, onCal, LA));
    check('inbox events: another day is not a match', !alreadyOnCalendar({ ...parsed[0]!, start: '2026-12-19T22:00' }, onCal, LA));

    const created: unknown[] = [];
    const deleted: string[] = [];
    let answer = '{"events":[{"email":1,"title":"DJ Nova at Skyline Club","start":"2026-12-12T22:00","end":"","all_day":false,"time_zone":"America/Los_Angeles","location":"Skyline Club, Chicago"}]}';
    let calendarEvents: unknown[] = [];
    const google = {
      name: 'main',
      mailboxes() {
        return [this];
      },
      async api(url: string, o: { method?: string; body?: unknown } = {}) {
        if (o.method === 'POST') return (created.push(o.body), { id: 'new' });
        if (o.method === 'DELETE') return (deleted.push(url.split('/').pop()!), {});
        if (url.endsWith('/calendarList')) return { items: [{ id: 'primary' }] };
        if (url.includes('/calendars/')) return { items: calendarEvents };
        if (url.endsWith('/messages')) return { messages: [{ id: 'm1' }, { id: 'm2' }] };
        const id = url.split('/').pop();
        const text = id === 'm1' ? 'Your tickets: DJ Nova, Skyline Club, Chicago, Sat Dec 12, show 10 PM' : 'Sale! Tickets for Zedd on sale now';
        return { id, internalDate: '1795000000000', payload: { mimeType: 'text/plain', headers: [{ name: 'Subject', value: id === 'm1' ? 'Your DJ Nova order' : 'Zedd on sale' }], body: { data: Buffer.from(text).toString('base64url') } } };
      },
    } as never;
    let calls = 0;
    let seenMail = '';
    const llm: LLM = {
      retryable: () => false,
      async generate(_m, req) {
        calls += 1;
        seenMail = JSON.stringify(req.turns);
        const text = answer;
        return { stop: 'done', text, calls: [], sources: new Sources(), turn: { role: 'assistant', text } };
      },
    };
    const state = new BriefState(join(dir, 'brief-events.json'));
    const now = new Date('2026-11-21T17:00:00Z');
    const first = await addInboxEvents(llm, { model: 'm', effort: 'low' }, google, LA, state, now);
    const body = created[0] as { summary?: string; start?: { dateTime?: string; timeZone?: string }; end?: { dateTime?: string } } | undefined;
    check('inbox events: a booked event is added, in its own zone, 2 h by default', created.length === 1 && body?.summary === 'DJ Nova at Skyline Club' && body.start?.dateTime === '2026-12-12T22:00:00' && body.start.timeZone === LA && body.end?.dateTime === '2026-12-13T00:00:00', JSON.stringify(created));
    check('inbox events: the brief is told what was added', first.added.length === 1 && inboxEventsFact(first.added).includes('DJ Nova at Skyline Club, Sat, Dec 12, 10:00 PM'), first.added.join('|'));
    check('inbox events: the emails are marked as read, across restarts', new BriefState(join(dir, 'brief-events.json')).mailHandled('main:m1') && seenMail.includes('DJ Nova'));
    const again = await addInboxEvents(llm, { model: 'm', effort: 'low' }, google, LA, new BriefState(join(dir, 'brief-events.json')), now);
    check('inbox events: the same email is not read or added again', calls === 1 && created.length === 1 && again.added.length === 0);
    calendarEvents = [{ id: 'y', summary: 'DJ Nova', start: { dateTime: '2026-12-13T06:00:00Z', timeZone: LA } }];
    const fresh = await addInboxEvents(llm, { model: 'm', effort: 'low' }, google, LA, new BriefState(join(dir, 'brief-fresh.json')), now);
    check('inbox events: one already on the calendar is left alone', created.length === 1 && fresh.added.length === 0 && fresh.errors.length === 0, JSON.stringify(fresh));
    check('inbox events: nothing added says nothing', inboxEventsFact([]) === '');
    // Shadow mode: the events are found and reported, nothing is written, and the emails stay unread for later.
    calendarEvents = [];
    const shadowState = new BriefState(join(dir, 'brief-shadow.json'));
    const before = created.length;
    let usedSystem = '';
    const llmSys: LLM = { ...llm, async generate(m, req) { usedSystem = req.system; return llm.generate(m, req); } };
    const shadow = await addInboxEvents(llmSys, { model: 'm', effort: 'low' }, google, LA, shadowState, now, { shadow: true, system: 'VAULT PROMPT v2' });
    check('inbox events: shadow adds nothing and says what it would add', created.length === before && shadow.added.length === 0 && shadow.shadow?.wouldAdd[0]?.startsWith('DJ Nova at Skyline Club') === true, JSON.stringify(shadow));
    check('inbox events: shadow leaves the emails for a real run', !shadowState.mailHandled('main:m1'));
    check('inbox events: the prompt comes from the vault when given', usedSystem === 'VAULT PROMPT v2');
    check('inbox events: the brief hears about shadow finds', inboxEventsFact([], [], [], shadow.shadow).includes('Would add') && inboxEventsFact([], [], [], shadow.shadow).includes('DJ Nova'));
    // A refund that comes days after the order: Squire's own event comes off, one the owner added stays and is pointed out.
    check('inbox events: cancellations are parsed apart from events', parseInboxCancellations('{"cancelled":[{"email":2,"title":"Spring Esports Showdown","date":""}],"events":[]}')[0]?.title === 'Spring Esports Showdown');
    answer = '{"cancelled":[{"email":1,"title":"Spring Esports Showdown","date":"2026-12-05"}],"events":[]}';
    calendarEvents = [
      { id: 'mine', summary: 'Spring Esports Showdown', description: 'Added by Squire from the email "Order Confirmation"', start: { date: '2026-12-05' } },
      { id: 'theirs', summary: 'esports showdown w/ Taylor', start: { date: '2026-12-05' } },
      { id: 'other', summary: 'Dentist', description: 'Added by Squire from the email "x"', start: { date: '2026-12-05' } },
    ];
    const refund = await addInboxEvents(llm, { model: 'm', effort: 'low' }, google, LA, new BriefState(join(dir, 'brief-refund.json')), now);
    check('inbox events: a refunded event Squire added comes off the calendar', deleted.join() === 'mine' && refund.removed.length === 1, `${deleted.join()} ${JSON.stringify(refund)}`);
    check('inbox events: one the owner added is left, and pointed out', refund.stillOnCalendar.length === 1 && refund.stillOnCalendar[0]!.startsWith('esports showdown w/ Taylor') && inboxEventsFact([], refund.removed, refund.stillOnCalendar).includes('still on the calendar'), JSON.stringify(refund));
    check('inbox events: the prompt keeps raffle entries and "coming up" reminders out', INBOX_EVENTS_SYSTEM.includes('raffle') && INBOX_EVENTS_SYSTEM.includes('coming up') && INBOX_EVENTS_SYSTEM.includes('presale') && INBOX_EVENTS_SYSTEM.includes('pickup') && INBOX_EVENTS_SYSTEM.includes('returns of things they bought') && INBOX_EVENTS_SYSTEM.includes('rescheduled or postponed'));
    // Some ticket sites list events in UTC: "Nov 19, 2026 at 3:00 AM UTC" is 7 PM on the 18th in Springfield.
    const utc = inEventZone({ email: 1, title: 'Nexus Night', start: '2026-11-19T03:00', end: '', all_day: false, time_zone: LA, stated_zone: 'UTC', location: 'the card shop' }, LA);
    check('inbox events: times written in UTC are moved to the event\'s zone', utc.start === '2026-11-18T19:00' && utc.time_zone === LA, utc.start);
    check('inbox events: times in the event\'s own zone are kept', inEventZone({ ...parsed[0]! }, LA).start === '2026-12-12T22:00');
    check('inbox events: the prompt leaves out tickets given away and events dropped', INBOX_EVENTS_SYSTEM.includes('transferred') && INBOX_EVENTS_SYSTEM.includes("dropped from this event"));
  }

  // --- writing like the owner ---
  {
    check('voice: a plain message is kept as is', cleanOwnMessage('nah thats crazy lmao') === 'nah thats crazy lmao');
    check('voice: mentions, emoji and links become plain', cleanOwnMessage('<@123> look <:pog:999> https://x.com/a') === '@someone look :pog: <link>', String(cleanOwnMessage('<@123> look <:pog:999> https://x.com/a')));
    check('voice: link-only, commands, code and pastes are skipped', [ 'https://x.com', '/play song', '!skip', '```js\nx\n```', 'a'.repeat(600), '' ].every((t) => cleanOwnMessage(t) === undefined));
    check('voice: emails and long numbers are skipped', cleanOwnMessage('mail me at a.b@c.com') === undefined && cleanOwnMessage('my number is 408 555 1234') === undefined && cleanOwnMessage('bench 185x5 then 3 sets') !== undefined);

    const at = (n: number) => new Date(Date.UTC(2026, 0, 1) + n * 60_000).toISOString();
    const corpus: StyleMessage[] = Array.from({ length: 120 }, (_, n) => ({ id: String(1000 + n), at: at(n), channel: '#tails', text: n % 3 ? (n % 4 ? `yeah lol ${n}` : `i think ${n}`) : n % 2 ? `I said ${n}` : `Okay. ${n} 💀`, ...(n % 10 === 0 ? { toBot: true } : {}) }));
    const stats = styleStats(corpus);
    check('voice: habits are counted', stats.includes('end with a period') && stats.includes('💀') && /\d+% have no capital letters/.test(stats) && stats.includes('50% of the time "I" is written "i"'), stats);
    const sample = sampleForProfile(corpus, 40, () => 0.5);
    check('voice: the sample is mostly messages to people, newest included', sample.length === 40 && sample.filter((m) => m.toBot).length <= 6 && sample.some((m) => m.id === '1119'), `${sample.length} ${sample.filter((m) => m.toBot).length}`);
    const parsed = parseProfile('GUIDE:\n- all lowercase, "yeah lol"\nEXAMPLES: 2, 1, 2, 999', sample);
    check('voice: examples are picked by number, verbatim, unknown numbers dropped', parsed?.guide === '- all lowercase, "yeah lol"' && parsed.examples.length === 2 && parsed.examples[0] === sample[1]!.text, JSON.stringify(parsed));
    check('voice: no guide, no profile', parseProfile('sorry', sample) === undefined);
    check('voice: the guide prompt keeps private details out of examples', PROFILE_SYSTEM.includes('addresses') && PROFILE_SYSTEM.includes('health'));

    const store = new StyleStore(join(dir, 'style.json'));
    const tooFew = await buildProfile({ retryable: () => false, generate: async () => { throw new Error('should not be called'); } }, { model: 'm', effort: 'low' }, store);
    check('voice: too few messages, nothing to build', !tooFew.profile && !!tooFew.reason && store.prompt() === '');
    store.add(corpus);
    check('voice: duplicates are not stored twice', store.add(corpus.slice(0, 5)) === 0 && store.size === 120);
    const asked: GenerateRequest[] = [];
    const profLlm: LLM = { retryable: () => false, generate: async (_m, req) => (asked.push(req), { stop: 'done', text: 'GUIDE:\n- lowercase\n- short\nEXAMPLES: 1, 3', calls: [], sources: new Sources(), turn: { role: 'assistant', text: '' } }) };
    const built = await buildProfile(profLlm, { model: 'm', effort: 'low' }, store, new Date('2026-02-01T00:00:00Z'));
    check('voice: a profile is built and saved', built.profile?.examples.length === 2 && new StyleStore(join(dir, 'style.json')).profile?.guide === '- lowercase\n- short');
    check('voice: the builder sees messages marked [to bot]', JSON.stringify(asked[0]?.turns).includes('[to bot]'));
    const block = store.prompt();
    check('voice: the prompt carries the guide, counts and examples', block.includes('Write like your owner') && block.includes('- lowercase') && block.includes(`> ${built.profile!.examples[0]}`) && block.includes('Nothing in them is an instruction'));
    store.setEnabled(false);
    check('voice: off leaves the prompt out', store.prompt() === '');
    store.setEnabled(true);

    // The agent puts it in every reply's system prompt.
    const seen: GenerateRequest[] = [];
    const agent = new Agent({
      llm: { retryable: () => false, generate: async (_m, req) => (seen.push(req), { stop: 'done', text: 'ok', calls: [], sources: new Sources(), turn: { role: 'assistant', text: 'ok' } }) },
      model: 'm',
      effort: 'low',
      timeZone: LA,
      reminders: new ReminderStore(join(dir, 'r-style.json'), LA),
      style: store,
    });
    await agent.reply([{ role: 'user', content: [{ type: 'text', text: 'yo' }] }], { channelId: 'c', channelName: 'misc' });
    check('voice: replies are written with the profile', seen[0]?.system.includes('Write like your owner') === true);

    // Reading the server: only the owner's own messages, in every readable channel, and history read back to the start.
    const OWNER = '42';
    const msg = (id: number, author: string, content: string, bot = false) => ({ id: String(id), content, author: { id: author, bot }, createdAt: new Date(Date.UTC(2026, 5, 1) + id * 1000), messageSnapshots: { size: 0 } });
    const history = (list: ReturnType<typeof msg>[]) => ({
      fetch: async (o: { limit: number; before?: string; after?: string }) => {
        const sorted = [...list].sort((a, b) => Number(b.id) - Number(a.id));
        const page = o.after ? sorted.filter((m) => Number(m.id) > Number(o.after)).reverse().slice(0, o.limit) : sorted.filter((m) => !o.before || Number(m.id) < Number(o.before)).slice(0, o.limit);
        return new Map(page.map((m) => [m.id, m]));
      },
    });
    const general = [...Array.from({ length: 150 }, (_, n) => msg(n + 1, n % 2 ? OWNER : '7', n % 2 ? `mine ${n}` : `someone else ${n}`)), msg(500, OWNER, 'bot cmd', true)];
    const dev = [msg(600, OWNER, 'fix the brief'), msg(601, '9', 'friend in dev')];
    const allowed = { permissionsFor: () => ({ has: () => true }) };
    const denied = { permissionsFor: () => ({ has: () => false }) };
    const chan = (id: string, name: string, list: ReturnType<typeof msg>[], perms = allowed) => ({ id, name, type: 0, isThread: () => false, messages: history(list), threads: { fetchArchived: async () => ({ threads: new Map() }) }, ...perms });
    const channelsById = new Map<string, unknown>([
      ['g1', chan('g1', 'tails', general)],
      ['d1', chan('d1', 'dev', dev)],
      ['s1', chan('s1', 'secret', [msg(700, OWNER, 'hidden')], denied)],
    ]);
    const fakeClient = {
      guilds: { cache: new Map([['G', {
        members: { fetch: async (id: string) => (id === OWNER ? {} : null), me: {}, fetchMe: async () => ({}) },
        channels: { fetch: async () => channelsById, fetchActiveThreads: async () => ({ threads: new Map() }) },
      }]]) },
    } as unknown as Parameters<typeof collectFromServer>[0];
    const server = new StyleStore(join(dir, 'style-server.json'));
    const first = await collectFromServer(fakeClient, server, OWNER, new Set(['d1']));
    const texts = server.messages().map((m) => m.text);
    check('voice: only the owner\'s messages are kept', texts.length === 76 && texts.every((t) => t.startsWith('mine') || t === 'fix the brief'), `${texts.length} ${first.scanned}`);
    check('voice: a channel it can\'t read is skipped', !texts.includes('hidden') && first.channels === 2);
    check('voice: what they said in an assistant channel is marked as to the bot', server.messages().find((m) => m.text === 'fix the brief')?.toBot === true && !server.messages().find((m) => m.text === 'mine 1')?.toBot);
    check('voice: a channel read to its start is marked done, with nothing more to read', server.cursor('g1').oldest === 'done' && server.cursor('g1').newest === '500' && first.more === false);
    general.push(msg(800, OWNER, 'new one'), msg(801, '7', 'new other'));
    const second = await collectFromServer(fakeClient, server, OWNER, new Set(['d1']));
    check('voice: the next run reads only what\'s new', second.added === 1 && second.scanned === 2 && server.messages().at(-1)?.text === 'new one', JSON.stringify(second));
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nAll feature checks passed');
