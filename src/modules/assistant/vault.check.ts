/**
 * Offline checks for the vault's structure: the ontology migration, syncs and
 * the vault lint. Everything runs in a temp vault.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Vault } from '../../vault.js';
import { applyMigration, describe, ONTOLOGY_NOTE, planMigration } from './ontology.js';
import { noteFields } from './taskNotes.js';
import { runSyncs, scrubSubject, senderName, SYNC_STATUS, writePlaces } from './sync.js';
import type { GoogleAccount } from './google.js';
import type { SavedPlace } from './places.js';
import { factoryGuard } from './factoryGuard.js';
import { applyFixes, lintVault, nightlyHealth } from './vaultLint.js';
import { utimesSync } from 'node:fs';
import { applyProposals, candidates, parseProposals, validProposals, VAULT_HEALTH_PROMPT, weeklyVaultHealth } from './vaultHealth.js';
import { Sources, type LLM } from './llm.js';
import { CASE_RUNNERS, loadCases } from './evals.js';
import { seedCases, SEED_COUNTS } from './codeEvals.js';
import { jobNames, jobSettings } from './factory.js';

let failures = 0;
const check = (label: string, ok: boolean, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${label.padEnd(52, '.')} ${ok ? 'OK' : 'FAIL'}  ${detail}`);
};
const LA = 'America/Los_Angeles';
const temp = () => new Vault(mkdtempSync(join(tmpdir(), 'squire-vault-')));

// --- ontology migration ---
{
  const vault = temp();
  try {
    vault.write('Cafes/Fogline.md', 'Good pour-over.\n');
    vault.write('Cafes/Ridge Coffee.md', '---\ntype: favourite\n---\nMine.\n');
    vault.write('Travel/Japan/Tokyo food.md', 'Places to eat.\n');
    vault.write('Travel/Japan/Japan itinerary v2.md', '---\ntrip: somewhere else\n---\nDay 1.\n');
    vault.write('Travel/Chicago/Chicago.md', '# Chicago\n\nMy hub.\n');
    vault.write('proj-ideas/Squire.md', 'Bot ideas.\n');
    vault.write('notes/Jane.md', '---\ntype: person\n---\nMet at work.\n');
    vault.write('notes/Bob.md', '---\ntype: person\n---\nOld friend.\n');
    vault.write('notes/Links.md', 'See [[notes/Bob]].\n');
    vault.write('Training/Training.md', 'plan\n');
    vault.write('Squire/Workouts/2026-11-01.md', 'workout\n');
    vault.write('Recipes/Meal/Curry.md', 'curry\n');
    const before = vault.list().map((p) => [p, vault.read(p)] as const);
    const plan = planMigration(vault, LA);
    const lines = plan.map(describe);
    check('the migration is a dry run until applied', vault.list().every((p) => before.some(([b, t]) => b === p && t === vault.read(p))) && vault.list().length === before.length);
    check('folders give a missing type', lines.some((l) => l.includes('Cafes/Fogline.md: type: place, category: cafe')) && lines.some((l) => l.includes('proj-ideas/Squire.md: type: project')), lines.join('\n'));
    check('a type the owner set is left alone', !lines.some((l) => l.includes('Cafes/Ridge Coffee.md')));
    check('trip notes link to their trip, unless set', lines.some((l) => l === 'add fields  Travel/Japan/Tokyo food.md: trip: [[Travel/Japan/Japan]]') && !lines.some((l) => l.includes('itinerary v2.md: trip')));
    check('a trip without a hub gets one, an existing hub only a type', lines.some((l) => l === 'create      Travel/Japan/Japan.md (index note)') && lines.some((l) => l === 'add fields  Travel/Chicago/Chicago.md: type: trip') && !lines.some((l) => l.startsWith('create      Travel/Chicago/Chicago.md')));
    check('typed loose notes move home, with a redirect if path-linked', lines.includes('move        notes/Jane.md -> People/Jane.md') && lines.some((l) => l.startsWith('move        notes/Bob.md -> People/Bob.md (redirect')));
    check('training, workouts and recipes are untouched', !lines.some((l) => /Training|Workouts|Recipes/.test(l)));
    const hub = plan.find((c) => c.kind === 'create' && c.path === 'Travel/Japan/Japan.md');
    check('the hub has a versions table', !!hub && hub.kind === 'create' && hub.content.includes('| [[Travel/Japan/Japan itinerary v2]] | v2 |') && hub.content.includes('type: trip'), hub && 'content' in hub ? hub.content : '');

    vault.write('Cafes/Fogline.md', '---\ncategory: bakery\n---\nGood pour-over.\n');
    const { done, skipped, log } = applyMigration(vault, plan, LA);
    const bb = noteFields(vault.read('Cafes/Fogline.md')!);
    check('apply re-checks fields the owner set since', bb.type === 'place' && bb.category === 'bakery' && vault.read('Cafes/Fogline.md')!.endsWith('Good pour-over.\n'));
    check('apply moves and leaves redirects', vault.read('People/Jane.md') !== undefined && vault.read('notes/Jane.md') === undefined && noteFields(vault.read('notes/Bob.md') ?? '').type === 'redirect');
    check('apply keeps bodies and writes a log', vault.read('Travel/Japan/Tokyo food.md')!.endsWith('Places to eat.\n') && !!vault.read(log)?.includes('Ontology migration') && vault.read(ONTOLOGY_NOTE) !== undefined, `${done.length} done, ${skipped.join('; ')}`);
    const again = planMigration(vault, LA).map(describe);
    check('a second run has nothing left to do', again.length === 0, again.join('\n'));
    vault.write('Travel/Japan/Osaka.md', 'Osaka.\n');
    const later = planMigration(vault, LA).map(describe);
    check('index tables refresh between their markers only', later.includes('index table Travel/Japan/Japan.md') && later.includes('index table Travel/Travel.md') === false, later.join('\n'));
  } finally {
    rmSync(vault.root, { recursive: true, force: true });
  }
}

// --- syncs ---
{
  check('booking subjects lose codes and card numbers', scrubSubject('Your booking ABC12X is confirmed: Hotel Sunroute, Apr 3 2026') === 'Your booking is confirmed: Hotel Sunroute, Apr 3 2026' && !scrubSubject('Receipt for card ending 1234 order #99887766').includes('1234') && !scrubSubject('order #99887766').includes('9988'), scrubSubject('Your booking ABC12X is confirmed: Hotel Sunroute, Apr 3 2026'));
  check('only the sender name is kept', senderName('"Japan Airlines" <noreply@airline.example>') === 'Japan Airlines' && senderName('bookings@hotel.com') === 'hotel.com');
  const vault = temp();
  try {
    const now = new Date('2026-11-21T12:00:00Z');
    const fake = {
      api: async (url: string, o: { params?: Record<string, unknown> } = {}) => {
        if (url.endsWith('/calendarList')) return { items: [{ id: 'primary', summary: 'Alex' }] };
        if (url.includes('/events')) return { items: [
          { id: 'e1', summary: 'Dentist', location: 'Main St', description: 'SECRET notes', start: { dateTime: '2026-11-25T09:00:00-08:00' }, end: { dateTime: '2026-11-25T10:00:00-08:00' } },
          { id: 'e2', summary: 'Flight to Tokyo', description: 'Added by Squire from the email: JL1', start: { dateTime: '2026-12-03T11:00:00-08:00' }, end: { dateTime: '2026-12-03T23:00:00-08:00' } },
        ] };
        if (url.endsWith('/messages')) return { messages: [{ id: 'm1' }], q: o.params?.q };
        if (url.includes('/messages/m1')) return { id: 'm1', internalDate: String(now.getTime()), snippet: 'BODY TEXT 4111111111111111', payload: { headers: [{ name: 'From', value: 'Japan Airlines <noreply@airline.example>' }, { name: 'Subject', value: 'Booking ABC123 confirmed' }] } };
        throw new Error(`unexpected ${url}`);
      },
    } as unknown as GoogleAccount;
    const place = (name: string, extra: Partial<SavedPlace> = {}): SavedPlace => ({ key: name, list: 'Coffee', name, source: 'list', address: '1 Main St, Salem', mapsUrl: 'https://maps.google.com/?cid=1', ...extra });
    vault.write('Squire/Sync/Places/Mine.md', '---\ntype: place\n---\nMy own words.\n');
    const status = await runSyncs(vault, { google: fake, places: [place('Corner Cafe'), place('Mine'), place('Chat spot', { source: 'chat' })] }, LA, now);
    const cal = vault.read('Squire/Sync/Calendar.md') ?? '';
    const book = vault.read('Squire/Sync/Bookings.md') ?? '';
    check('the calendar snapshot has events, no descriptions', cal.includes('| Dentist | Main St |') && !cal.includes('SECRET'), cal);
    check('bookings keep links and facts, never bodies or codes', book.includes('#all/m1') && book.includes('| Japan Airlines | Booking confirmed |') && !book.includes('BODY') && !book.includes('ABC123') && !book.includes('noreply@') && book.includes('Flight to Tokyo'), book);
    check('place notes are typed, synced only while sync: maps', noteFields(vault.read('Squire/Sync/Places/Corner Cafe.md') ?? '').type === 'place' && vault.read('Squire/Sync/Places/Mine.md')!.includes('My own words.') && vault.read('Squire/Sync/Places/Chat spot.md') === undefined);
    check('the status note says when each source synced', status.length === 3 && !!noteFields(vault.read(SYNC_STATUS) ?? '').last_sync);
    const before = vault.mtime('Squire/Sync/Calendar.md');
    await runSyncs(vault, { google: fake, places: [place('Corner Cafe')] }, LA, now);
    check('a sync with nothing new rewrites nothing', vault.mtime('Squire/Sync/Calendar.md') === before && writePlaces(vault, [place('Corner Cafe')]).wrote === 0);
    let refused = '';
    try {
      factoryGuard(vault, 'Squire/Sync/Calendar.md', 'write', {});
    } catch (err) {
      refused = String(err);
    }
    check('the notes tools cannot write Squire/Sync', refused.includes('read-only'));
    const failing = { api: async () => { throw new Error('Google API error 401: expired'); } } as unknown as GoogleAccount;
    const failed = await runSyncs(vault, { google: failing }, LA, now);
    check('a failing source is reported, not thrown', failed.every((l) => l.includes('failed')) && vault.read('Squire/Sync/Calendar.md') === cal);
  } finally {
    rmSync(vault.root, { recursive: true, force: true });
  }
}

// --- vault lint ---
{
  const vault = temp();
  try {
    const now = new Date('2026-11-21T12:00:00Z');
    vault.write('Recipes/Meal/Curry.md', 'See [[Goan fish curry]], [[Missing note]], ![[photo.jpg]] and `[[Not a link]]`.\n');
    vault.write('Recipes/Meal/Goan Fish Curry.md', 'curry\n');
    vault.write('Factory/Jobs/brief.md', '---\nevals: "[[Factory/Evals/brief]]"\n---\nSee [[Recipes/Meal]] for the folder.\n');
    vault.write('Travel/Japan/Plan.md', '---\ntype: trip\n---\nSee [[notes/Bob]] and [[Travel/<Trip>/<Trip>]].\n');
    vault.write('People/Bob.md', '---\ntype: person\n---\nBob.\n');
    vault.write('notes/Bob.md', '---\ntype: redirect\nmoved_to: "[[People/Bob]]"\n---\n\nMoved to [[People/Bob]].\n');
    vault.write('notes/Bad.md', '---\ntype: [unclosed\n---\nhi\n');
    vault.write('notes/Odd.md', '---\ntype: favourite\n---\nhi\n');
    vault.write('notes/Blank.md', '   \n');
    vault.write('Squire/Inbox/Old.md', 'old\n');
    utimesSync(vault.abs('Squire/Inbox/Old.md'), new Date('2026-11-01'), new Date('2026-11-01'));
    vault.write('Squire/Tasks/2026-11-01 Stuck.md', '---\nstatus: doing\nrequested: "2026-11-01T10:00:00-08:00"\n---\n# Stuck\n');
    vault.write('Squire/Tasks/2026-11-02 Report.md', '---\nstatus: done\n---\nSaved [[notes/Bob]].\n');
    const r = lintVault(vault, now);
    check('lint: broken links, skipping attachments and code', r.broken.length === 1 && r.broken[0]!.link === 'Missing note', JSON.stringify(r.broken));
    check('lint: frontmatter and folder links are not broken', !r.broken.some((b) => b.path === 'Factory/Jobs/brief.md'), JSON.stringify(r.broken));
    check('lint: a case-only difference is not broken', !r.broken.some((b) => b.link === 'Goan fish curry'));
    check('lint: two notes with one name are flagged', r.ambiguous.some((a) => a.name === 'Bob'));
    check('lint: bad YAML and unknown types', r.badFrontmatter.some((b) => b.path === 'notes/Bad.md') && r.badFrontmatter.some((b) => b.path === 'notes/Odd.md' && b.why.includes('favourite')));
    check('lint: empty, old inbox and stuck tasks', r.empty.includes('notes/Blank.md') && r.oldInbox.includes('Squire/Inbox/Old.md') && r.stuck.includes('Squire/Tasks/2026-11-01 Stuck.md'));
    check('lint: links to a redirect are the fixes', r.fixes.length === 2 && r.fixes.every((f) => f.from === 'notes/Bob' && f.to === 'People/Bob'), JSON.stringify(r.fixes));
    const plan = vault.read('Travel/Japan/Plan.md');
    const path = nightlyHealth(vault, LA, now);
    const health = vault.read(path) ?? '';
    check('nightly: fixes only Squire\'s own notes', vault.read('Squire/Tasks/2026-11-02 Report.md')!.includes('[[People/Bob]]') && vault.read('Travel/Japan/Plan.md') === plan);
    check('nightly: the health note lists the rest', path === 'Squire/Health/2026-11-21.md' && health.includes('Missing note') && health.includes('npm run vault:lint -- --fix') && health.includes('Fixed (1)'), health);
    check('the health note is not linted itself', !lintVault(vault, now).broken.some((b) => b.path.startsWith('Squire/Health/')));
    const done = applyFixes(vault, lintVault(vault, now).fixes);
    check('--fix changes only the link target', done.length === 1 && vault.read('Travel/Japan/Plan.md') === plan!.replace('[[notes/Bob]]', '[[People/Bob]]'));
  } finally {
    rmSync(vault.root, { recursive: true, force: true });
  }
}

// --- weekly vault-health factory ---
{
  const vault = temp();
  try {
    const now = new Date('2026-11-22T12:00:00Z');
    const old = new Date('2025-01-01');
    const put = (p: string, text: string, when?: Date) => {
      vault.write(p, text);
      if (when) utimesSync(vault.abs(p), when, when);
    };
    put('proj-ideas/Untitled 3.md', 'x\n', old);
    put('proj-ideas/Bot.md', `${'A long project note about the bot. '.repeat(10)}\n`, old);
    put('Recipes/Meal/Curry.md', `${'Curry steps. '.repeat(20)} [[Bot]]\n`);
    put('Squire/Inbox/Soup notes.md', `${'Hot and sour soup. '.repeat(10)}\n`);
    put('Training/Old split.md', 'x\n', old);
    put('Squire/Sync/Calendar.md', 'x\n', old);
    const list = candidates(vault, now);
    check('health: stale stubs and the inbox are candidates', list.some((l) => l.startsWith('proj-ideas/Untitled 3.md') && l.includes('nothing links')) && list.some((l) => l.startsWith('Squire/Inbox/Soup notes.md') && l.includes('not filed')), list.join('\n'));
    check('health: linked, protected and synced notes are not', !list.some((l) => /^(proj-ideas\/Bot|Training|Squire\/Sync)/.test(l)), list.join('\n'));
    const answer = '- archive | proj-ideas/Untitled 3.md | empty stub\n- file | Squire/Inbox/Soup notes.md -> Recipes/Soup | a soup\n- archive | Training/Old split.md | old\n- archive | nope.md | gone\n- merge | a.md + b.md -> c.md | bad\n- something else';
    const parsed = parseProposals(answer);
    check('health: proposals parse; bad lines drop', parsed.length === 5 && parsed[1]!.target === 'Recipes/Soup', JSON.stringify(parsed));
    check('health: protected and missing notes are refused', validProposals(vault, parsed).length === 2);
    let asked = '';
    const fake: LLM = { retryable: () => false, generate: async (_m, req) => { asked = JSON.stringify(req.turns); return { stop: 'done', text: answer, calls: [], sources: new Sources(), turn: { role: 'assistant', text: answer, calls: [] } }; } };
    const before = vault.list().map((p) => [p, vault.read(p)] as const);
    const run = await weeklyVaultHealth(vault, fake, { model: 'm', effort: 'low' }, { text: VAULT_HEALTH_PROMPT, name: 'built-in' }, LA, now);
    const note = vault.read(run.path!) ?? '';
    check('health: proposing writes only the checklist note', before.every(([p, t]) => vault.read(p) === t) && vault.list().length === before.length + 1 && note.includes('- [ ] archive [[proj-ideas/Untitled 3]]') && asked.includes('Untitled 3'), note);
    vault.write(run.path!, note.replace('- [ ] archive [[proj-ideas/Untitled 3]]', '- [x] archive [[proj-ideas/Untitled 3]]'));
    const applied = applyProposals(vault, run.path!);
    check('health: apply moves only the ticked ones', applied.done.length === 1 && vault.read('Archive/proj-ideas/Untitled 3.md') === 'x\n' && vault.read('Squire/Inbox/Soup notes.md') !== undefined && vault.read(run.path!)!.includes('✓ done'));
    check('health: applying again does nothing', applyProposals(vault, run.path!).done.length === 0);
    check('health: it is a factory job with seeded cases', jobNames(vault).includes('vault-health') && jobSettings(vault, 'vault-health').kind === 'code' && seedCases(vault, 'vault-health').length === SEED_COUNTS['vault-health'] && SEED_COUNTS['vault-health']! >= 5);
    const cases = loadCases(vault, 'vault-health');
    const stub = cases.find((c) => c.name === 'Stale stub')!;
    const ran = await CASE_RUNNERS['vault-health']!(stub, { vault, llm: fake, taskModel: 'm', judge: { model: 'm', effort: 'low' }, timeZone: LA, job: 'vault-health' }, fake);
    const two = await CASE_RUNNERS['vault-health']!(cases.find((c) => c.name === 'Two versions')!, { vault, llm: fake, taskModel: 'm', judge: { model: 'm', effort: 'low' }, timeZone: LA, job: 'vault-health' }, fake);
    check('health evals: expected proposals are code-checked', ran.verdicts!['Expected proposals']!.pass && !two.verdicts!['Expected proposals']!.pass, JSON.stringify([ran.verdicts, two.verdicts]));
  } finally {
    rmSync(vault.root, { recursive: true, force: true });
  }
}

if (failures) {
  console.error(`\n${failures} vault check(s) failed.`);
  process.exit(1);
}
console.log('\nAll vault checks passed.');
