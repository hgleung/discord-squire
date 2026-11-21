/**
 * Offline checks for factories: evals run against a scripted stand-in for the
 * API, in a sandbox, and are scored and written up. No network, no API key.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Vault } from '../../vault.js';
import { codeChecks, loadCases, RECIPE_CASES, resultsNote, resultsPath, runEvals, seedRecipeCases, estimateCost } from './evals.js';
import { Sources, type Generation, type LLM, type ToolCall } from './llm.js';
import { noteFields } from './taskNotes.js';
import { factoryDigest, jobRuns, proposeTestingPrompt, stuckTasks, updateRegistry, weeklyFactoryFacts } from './factoryDigest.js';
import { factoryGuard, FACTORY_POINTER } from './factoryGuard.js';
import { notesTools } from './notes.js';
import { WEEKLY_RULES } from './weekly.js';
import { eventsVerdict, seedCases, SEED_COUNTS } from './codeEvals.js';
import { photoVerdicts } from './photoEvals.js';
import { setsVerdict } from './trainingEvals.js';
import { parsePhotoActions, photoPrompt, PHOTO_ACTIONS, PHOTO_JOB_PROMPT } from './photo.js';
import { ALL_GROUPS } from './channelTools.js';
import { taskTools } from './tasks.js';
import { inShadow, latestTesting, writeRunNote } from './codeJobs.js';
import { jobNames, jobPrompt, jobSettings, scaffoldJob, seedJobs, seedPrompts } from './factory.js';
import { ReminderStore } from './reminders.js';
import { TaskRunner, TaskStore } from './tasks.js';
import { overCap, REGISTRY_NOTE, updateRegistryNote, checkWritePath } from './governance.js';
import { ActivityLog } from './activity.js';
import { comparisonNote, comparisonPath, readyToPromote, recordOnPrompt, resultsFromNote, trendLine, verdictOf } from './improve.js';
import { evalHistory } from './evals.js';

let failures = 0;
const check = (label: string, ok: boolean, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${label.padEnd(52, '.')} ${ok ? 'OK' : 'FAIL'}  ${detail}`);
};
const LA = 'America/Los_Angeles';
const gen = (calls: ToolCall[]): Generation => ({ stop: calls.length ? 'tool_use' : 'done', text: '', calls, sources: new Sources(), turn: { role: 'assistant', text: '', calls } });

// --- evals ---
{
  const dir = mkdtempSync(join(tmpdir(), 'squire-factory-'));
  try {
    const vault = new Vault(dir);
    vault.write('Recipes/Soup/Old soup.md', 'mine\n');
    vault.write('Recipes/Meal/Old meal.md', 'mine\n');
    const seeded = seedRecipeCases(vault);
    check('ten recipe cases are seeded', seeded.length === RECIPE_CASES.length && RECIPE_CASES.length >= 8 && RECIPE_CASES.length <= 10, `${seeded.length}`);
    check('seeding never overwrites cases', seedRecipeCases(vault).length === 0);
    const curry = loadCases(vault, 'recipe').find((c) => c.name === 'Curry halved');
    check('a case carries its input, ask, folder and checklist', !!curry && curry.ask.includes('half') && curry.folder === 'Recipes/Meal' && curry.checks.length === 5);

    // Only two cases for the scripted run.
    for (const p of vault.list('Factory/Evals/recipe')) rmSync(vault.abs(p));
    vault.write('Factory/Evals/recipe/Soup page.md', '---\ninput: https://example.com/soup\nfolder: Recipes/Soup\n---\n');
    vault.write('Factory/Evals/recipe/Cake page.md', '---\ninput: https://example.com/cake\nfolder: Recipes/Pastries\n---\n');
    vault.write('Factory/Evals/recipe/Old soup again.md', '---\ninput: https://example.com/old\nfolder: Recipes/Soup\nfrom: "[[Recipes/Soup/Old soup]]"\n---\n');
    const judged: string[] = [];
    const fake: LLM = {
      retryable: () => false,
      async generate(_m, req) {
        if (req.tools.some((t) => t.name === 'verdict')) {
          judged.push(JSON.stringify(req.turns));
          const soup = JSON.stringify(req.turns).includes('example.com/soup');
          const v = { pass: true, why: 'fine' };
          return gen([{ id: 'v', name: 'verdict', input: { estimates_labeled: v, units_consistent: v, no_invented_amounts: soup ? v : { pass: false, why: '2 cups flour is not in the source' } } }]);
        }
        const goal = JSON.stringify(req.turns[0]);
        const last = req.turns.at(-1)!;
        if (goal.includes('example.com/old')) {
          if (last.role !== 'tool') return gen([{ id: 'r', name: 'read_note', input: { path: 'Recipes/Soup/Old soup.md' } }]);
          return gen([{ id: 'f', name: 'finish_task', input: { outcome: 'done', report: last.results[0]!.isError ? 'Not saved yet, but I stopped.' : 'Already saved as Old soup.' } }]);
        }
        if (last.role === 'tool') return gen([{ id: 'f', name: 'finish_task', input: { outcome: 'done', report: 'Saved.' } }]);
        const soup = goal.includes('example.com/soup');
        return gen([{ id: 's', name: 'save_note', input: { title: soup ? 'Soup' : 'Cake', content: `Source: ${soup ? 'https://example.com/soup' : 'https://example.com/cake'}\n\n- 2 cups flour`, mode: 'create', folder: soup ? 'Recipes/Soup' : 'Recipes/Meal', sources: ['owner'] } }]);
      },
    };
    const run = await runEvals({ vault, llm: fake, taskModel: 'big', judge: { model: 'small', effort: 'low' }, timeZone: LA, job: 'recipe' });
    const soup = run.results.find((r) => r.case.name === 'Soup page')!;
    const cake = run.results.find((r) => r.case.name === 'Cake page')!;
    const again = run.results.find((r) => r.case.name === 'Old soup again')!;
    check('the note a case was built from is hidden from the job', again.report === 'Not saved yet, but I stopped.' && !again.pass, again.report);
    check('a case that meets its checklist passes', soup.pass && soup.output === 'Recipes/Soup/Soup.md', JSON.stringify(soup.verdicts));
    check('the wrong folder fails by code', !cake.pass && cake.verdicts.right_folder?.pass === false && cake.verdicts.right_folder.why.includes('Recipes/Meal'), cake.verdicts.right_folder?.why);
    check('the judge\'s verdicts are kept', cake.verdicts.no_invented_amounts?.pass === false && judged.length === 2, `${judged.length}`);
    check('evals write nothing to Recipes', vault.list('Recipes').join() === 'Recipes/Meal/Old meal.md,Recipes/Soup/Old soup.md' && vault.list('Squire').length === 0, vault.list('Recipes').join());
    const when = new Date('2026-11-21T18:00:00Z');
    const path = resultsPath(vault, 'recipe', when, LA);
    vault.write(path, resultsNote('recipe', run.prompt, run.results, when, LA, run.cost));
    const results = vault.read(path)!;
    const f = noteFields(results);
    check('results go to results/<date>.md with a pass rate', path === 'Factory/Evals/recipe/results/2026-11-21.md' && f.pass_rate === 0.33 && f.passed === 1 && f.prompt === 'built-in' && vault.list('Factory/Prompts').length === 0, JSON.stringify(f));
    check('a case that saved nothing shows its report', results.includes('> [!quote]- Report\n> Not saved yet, but I stopped.'));
    check('the results table has a row per case', /\| Soup page \| ✅ \| ✅ \| ✅ \| ✅ \| ✅ \| \*\*pass\*\* \|/.test(results) && /\| Cake page \|.*❌.*\| fail \|/.test(results));
    check('results never overwrite an earlier run that day', resultsPath(vault, 'recipe', when, LA).endsWith('2026-11-21 2.md'));
    check('results are not read as cases', loadCases(vault, 'recipe').length === 3);
    const none = codeChecks({ input: 'https://a.com/x', folder: 'Recipes/Meal', checks: ['sources_linked', 'right_folder'] }, undefined, undefined);
    check('no note saved fails the code checks', none.sources_linked?.pass === false && none.right_folder?.pass === false);
    const unlinked = codeChecks({ input: 'https://a.com/x', folder: 'Recipes/Meal', checks: ['sources_linked'] }, 'Recipes/Meal/X.md', 'Source: https://other.com/y');
    check('a note that drops the input link fails sources', unlinked.sources_linked?.pass === false, unlinked.sources_linked?.why);
    // The nightly review's Factories section.
    seedPrompts(vault);
    seedJobs(vault);
    vault.write(
      'Squire/Tasks/2026-11-21 Soup reel.md',
      '---\nstatus: done\noutput: "[[Recipes/Soup/Soup]]"\nfinished: 2026-11-21T09:00:00-08:00\nchannel: "#recipes"\njob: recipe\n---\n\n# Soup reel\n\n**Goal:** https://example.com/soup\n\n**Done when:** d\n',
    );
    vault.write('Recipes/Soup/Soup.md', 'Source: https://elsewhere.com/x\n');
    vault.write(
      'Squire/Tasks/2026-11-21 Cake reel.md',
      '---\nstatus: done\nfinished: 2026-11-21T10:00:00-08:00\njob: recipe\nshadow: true\nproposed: "[[Recipes/Pastries/Cake]]"\n---\n\n# Cake reel\n\n**Goal:** https://example.com/cake\n\n<!-- squire:proposal path="Recipes/Pastries/Cake.md" mode="create" -->\n````markdown\nSource: https://example.com/cake\n````\n<!-- /squire:proposal -->\n',
    );
    const runs = jobRuns(vault, 'recipe', new Date('2026-11-20T00:00:00Z'));
    check('real runs are read from task notes', runs.length === 2 && runs[0]!.failed.some((f) => f.includes('example.com/soup')) && runs[1]!.failed.length === 0, JSON.stringify(runs.map((r) => r.failed)));
    const digest = factoryDigest(vault, new Date('2026-11-20T00:00:00Z'));
    check('the digest has the pass rate and the failed eval items', digest.includes('recipe · production prompt "recipe v1" · shadow on') && digest.includes('1/3 (33%)') && digest.includes('eval case failed: Cake page') && digest.includes('Right folder'), digest);
    check('the digest lists failed runs and waiting proposals', digest.includes('run failed a checklist item: Soup reel') && digest.includes('shadow proposal waiting for the owner: Recipes/Pastries/Cake'), digest);
    check('the digest says to propose a testing prompt, not edit production', digest.includes('npm run prompt:propose -- recipe') && digest.includes('recipe v2 as testing'));
    const v1Before = vault.read('Factory/Prompts/recipe v1.md');
    const proposed = proposeTestingPrompt(vault, 'recipe', 'New rules.', 'File soups in Soup');
    const pf = noteFields(vault.read(proposed)!);
    check('a proposed prompt is a new testing version', proposed === 'Factory/Prompts/recipe v2.md' && pf.status === 'testing' && pf.version === 2 && pf.based_on === 'recipe v1' && vault.read('Factory/Prompts/recipe v1.md') === v1Before, JSON.stringify(pf));
    check('the next proposal takes the next version', proposeTestingPrompt(vault, 'recipe', 'x', 'y').endsWith('recipe v3.md'));
    check('later evals on the digest show a trend', (() => {
      vault.write('Factory/Evals/recipe/results/2026-11-22.md', '---\ndate: 2026-11-22T10:00:00-08:00\nprompt: recipe v2\npassed: 2\ntotal: 2\n---\n');
      const d = factoryDigest(vault, new Date('2026-11-20T00:00:00Z'));
      return d.includes('latest eval 2026-11-22 on "recipe v2": 2/2 (100%) · before: 2026-11-21 built-in 1/3 (33%)');
    })());
    check('the cost estimate is printed from list prices', estimateCost(10, 'claude-sonnet-5-5', 'claude-haiku-5-5') > 1 && estimateCost(10, 'claude-sonnet-5-5', 'claude-haiku-5-5') < 20);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- the factory framework: a job is a config ---
{
  const dir = mkdtempSync(join(tmpdir(), 'squire-framework-'));
  try {
    const vault = new Vault(dir);
    seedJobs(vault);
    const recipe = jobSettings(vault, 'recipe');
    const recipeNote = noteFields(vault.read('Factory/Jobs/recipe.md')!);
    check('the recipe job note has the README fields', ['trigger', 'channel', 'tools', 'write_paths', 'shadow', 'tier', 'evals', 'review'].every((k) => k in recipeNote) && recipe.trigger === 'event' && recipe.writePaths.join() === 'Recipes', JSON.stringify(recipeNote));
    const wrote = scaffoldJob(vault, 'receipts', { trigger: 'event', channel: '#misc', what: 'Turn a receipt into an expense row.' });
    check('factory new writes a job note, a testing prompt and a case', wrote.join() === 'Factory/Jobs/receipts.md,Factory/Prompts/receipts v1.md,Factory/Evals/receipts/Example.md' && noteFields(vault.read('Factory/Prompts/receipts v1.md')!).status === 'testing');
    let dup = '';
    try { scaffoldJob(vault, 'receipts'); } catch (err) { dup = (err as Error).message; }
    check('factory new never overwrites a job', dup.includes('already'), dup);
    check('a config-only job is a job', jobNames(vault).includes('receipts') && jobSettings(vault, 'receipts').shadow === true);
    let noProd = '';
    try { jobPrompt(vault, 'receipts'); } catch (err) { noProd = (err as Error).message; }
    check('a new job runs only once a prompt is production', noProd.includes('no production prompt') && jobPrompt(vault, 'receipts', 'receipts v1').name === 'receipts v1', noProd);
    vault.write('Factory/Prompts/receipts v1.md', vault.read('Factory/Prompts/receipts v1.md')!.replace('status: testing', 'status: production'));
    vault.write('Factory/Jobs/receipts.md', vault.read('Factory/Jobs/receipts.md')!.replace('tier: capable', 'tier: fast\neffort: high'));
    const models: { model: string; effort: string }[] = [];
    const systems: string[] = [];
    const fake: LLM = {
      retryable: () => false,
      async generate(m, req) {
        models.push({ model: m.model, effort: m.effort });
        systems.push(req.system);
        if (req.tools.some((t) => t.name === 'verdict')) return gen([{ id: 'v', name: 'verdict', input: { items: [{ pass: true, why: 'says so' }, { pass: false, why: 'made up a total' }] } }]);
        return gen([{ id: 'f', name: 'finish_task', input: { outcome: 'done', report: 'Logged $12.50 at Fogline.' } }]);
      },
    };
    const runner = new TaskRunner(new TaskStore(join(dir, 'tasks.json')), { llm: fake, model: 'big', fastModel: 'small', effort: 'low', timeZone: LA, reminders: new ReminderStore(join(dir, 'r.json'), LA), vault });
    runner.start({ title: 'Receipt', goal: 'photo', doneWhen: 'logged', deadline: new Date(Date.now() + 3600_000), channelId: 'c', channelName: 'misc', job: 'receipts' });
    await new Promise((r) => setTimeout(r, 30));
    check('the job note picks the model and effort, no deploy', models[0]?.model === 'small' && models[0]?.effort === 'high', JSON.stringify(models[0]));
    check('a config-only job runs its prompt note', systems[0]!.includes('Turn a receipt into an expense row.'));
    const run = await runEvals({ vault, llm: fake, taskModel: 'big', judge: { model: 'small', effort: 'low' }, timeZone: LA, job: 'receipts' });
    const ex = run.results[0];
    check('any job\'s checklist is judged item by item', !!ex && !ex.pass && ex.verdicts['The output says where its facts came from.']?.pass === true && ex.verdicts['Nothing in the output is invented.']?.pass === false, JSON.stringify(ex?.verdicts));
    const note = resultsNote('receipts', run.prompt, run.results, new Date(), LA, 0);
    check('a checklist results table numbers its items', note.includes('| Case | #1 | #2 | Pass |') && note.includes('made up a total'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- Factory/ is the owner's ---
{
  const dir = mkdtempSync(join(tmpdir(), 'squire-guard-'));
  try {
    const vault = new Vault(dir);
    seedPrompts(vault);
    seedJobs(vault);
    const README = '---\ntype: factory-readme\n---\n\n# Factory workflow\n\nMy words.\n\n## Job registry\n\n| Job | Status | Shadow | Prompt | Last eval pass rate |\n|---|---|---|---|---|\n| recipe from reel/link | planned | yes | | |\n\nAfter the table, mine too.\n';
    vault.write('Factory/README.md', README);
    vault.write('Factory/Evals/recipe/Case.md', '---\ninput: x\n---\n');
    const tools = (ownerText?: string) => new Map(notesTools(vault, LA, undefined, { ownerText }).map((h) => [h.def.name, h]));
    const save = (folder: string, title: string, content: string, ownerText?: string, mode = 'replace') =>
      Promise.resolve()
        .then(() => tools(ownerText).get('save_note')!.run({ title, content, mode, folder, sources: [] }))
        .then((r) => String(r))
        .catch((e: Error) => `REFUSED ${e.message}`);
    check('Factory/ notes can be read', String(await tools().get('read_note')!.run({ path: 'Factory/README.md' })).includes('My words.'));
    check('the README is refused', (await save('Factory', 'README', 'new')).startsWith('REFUSED') && vault.read('Factory/README.md') === README);
    check('a production prompt is refused', (await save('Factory/Prompts', 'recipe v1', '---\nstatus: production\n---\nx')).startsWith('REFUSED'));
    check('job notes and eval cases are refused', (await save('Factory/Jobs', 'recipe', 'x')).startsWith('REFUSED') && (await save('Factory/Evals/recipe', 'Case', 'x')).startsWith('REFUSED'));
    check('a new testing prompt is allowed', (await save('Factory/Prompts', 'recipe v5', '---\njob: recipe\nstatus: testing\nversion: 5\n---\nnew rules', undefined, 'create')).startsWith('Saved'));
    check('a testing prompt can\'t be made production', (await save('Factory/Prompts', 'recipe v5', '---\njob: recipe\nstatus: production\nversion: 5\n---\nx')).startsWith('REFUSED'));
    check('eval results are allowed', (await save('Factory/Evals/recipe/results', '2026-11-30', 'table', undefined, 'create')).startsWith('Saved'));
    check('the owner naming the note in their message allows it', (await save('Factory/Jobs', 'recipe', 'shadow off', 'turn shadow off in the recipe job note')).startsWith('Replaced'));
    let moved = '';
    try { await tools().get('move_note')!.run({ from: 'Factory/Prompts/recipe v1.md', to: 'Recipes/x.md' }); } catch (e) { moved = (e as Error).message; }
    let trashed = '';
    try { await tools().get('delete_note')!.run({ path: 'Factory/README.md' }); } catch (e) { trashed = (e as Error).message; }
    check('Factory/ notes can\'t be moved or trashed unasked', moved.includes('owner controls') && trashed.includes('owner controls') && vault.read('Factory/README.md') === README, moved);
    let direct = '';
    try { factoryGuard(vault, 'Factory/Prompts/recipe v1.md', 'write', { next: '---\nstatus: retired\n---\n' }); } catch (e) { direct = (e as Error).message; }
    check('the guard is in code, not only the prompt', direct.includes('production prompt'), direct);
    check('the assistant and workers are pointed at the README', FACTORY_POINTER.includes('Factory/README.md') && FACTORY_POINTER.includes('read_note'));

    // The registry: only the table changes, and the first time is a dry run.
    const dry = updateRegistry(vault);
    check('the first registry update is a dry run', !dry.wrote && vault.read('Factory/README.md') === README && dry.after.includes('<!-- squire:registry -->'));
    const applied = updateRegistry(vault, true);
    const after = vault.read('Factory/README.md')!;
    check('the registry table is generated between markers', applied.wrote && /\| recipe \| shadow \| no \| recipe v1 \|/.test(after) === false && /\| recipe \| \w+ \| (yes|no) \| recipe v1 \|/.test(after), after);
    check('the rest of the README stays as it was', after.startsWith('---\ntype: factory-readme\n---\n\n# Factory workflow\n\nMy words.\n\n## Job registry\n\n<!-- squire:registry -->') && after.endsWith('<!-- /squire:registry -->\n\nAfter the table, mine too.\n') && !after.includes('recipe from reel/link'));
    vault.write('Factory/Evals/recipe/results/2026-11-30.md', '---\ndate: 2026-11-30T10:00:00-08:00\nprompt: recipe v1\npassed: 9\ntotal: 10\n---\n');
    check('later updates need no dry run', updateRegistry(vault).wrote && vault.read('Factory/README.md')!.includes('90% (9/10, 2026-11-30)'));
    check('an unchanged registry isn\'t rewritten', !updateRegistry(vault).wrote);

    // The weekly review's Factories section.
    vault.write('Squire/Tasks/2026-11-20 Stuck.md', '---\nstatus: doing\nrequested: 2026-11-20T08:00:00-08:00\n---\n');
    vault.write('Squire/Tasks/2026-11-22 Fresh.md', '---\nstatus: doing\nrequested: 2026-11-22T08:00:00-08:00\n---\n');
    const now = new Date('2026-11-22T20:00:00Z');
    check('tasks doing for more than a day are found', stuckTasks(vault, now).map((s) => s.path).join() === 'Squire/Tasks/2026-11-20 Stuck.md');
    const weekly = weeklyFactoryFacts(vault, now);
    check('the weekly review gets each factory\'s pass rate and stuck tasks', weekly.includes('recipe: last eval 9/10 (90%)') && weekly.includes('more than 24 hours: 2026-11-20 Stuck'), weekly);
    check('the weekly rules ask for a Factories section', WEEKLY_RULES.includes('**Factories**') && WEEKLY_RULES.includes('waiting for approval'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- the other jobs, converted ---
{
  const dir = mkdtempSync(join(tmpdir(), 'squire-jobs-'));
  try {
    const vault = new Vault(dir);
    seedPrompts(vault);
    seedJobs(vault);
    check('every built-in job gets a job note and a v1 prompt', ['recipe', 'research', 'inbox-calendar', 'brief', 'photo'].every((j) => vault.read(`Factory/Jobs/${j}.md`) && vault.read(`Factory/Prompts/${j} v1.md`)));
    check('converted jobs start in shadow, photo stays live', ['research', 'inbox-calendar', 'brief'].every((j) => jobSettings(vault, j).shadow) && !jobSettings(vault, 'photo').shadow);
    for (const job of ['research', 'inbox-calendar', 'brief']) seedCases(vault, job);
    check('each converted job has at least 5 real-history cases', ['research', 'inbox-calendar', 'brief'].every((j) => (SEED_COUNTS[j] ?? 0) >= 5 && loadCases(vault, j).length === SEED_COUNTS[j]), JSON.stringify(SEED_COUNTS));
    check('no mail bodies kept: inbox cases are short re-tellings', loadCases(vault, 'inbox-calendar').every((c) => c.input.length < 400));

    // The inbox job's runner: the prompt under test, code checks on what it found.
    const answers: Record<string, string> = {
      'Club ticket': '{"events":[{"email":1,"title":"DJ Nova at Skyline Club","start":"2026-12-12T22:00","end":"","all_day":false,"time_zone":"America/Los_Angeles","location":"Skyline Club"}],"cancelled":[]}',
      'Raffle entry': '{"events":[{"email":1,"title":"Jordan 4 raffle","start":"2026-11-21T09:00","end":"","all_day":false,"time_zone":"America/Los_Angeles","location":""}],"cancelled":[]}',
    };
    const fake: LLM = {
      retryable: () => false,
      async generate(_m, req) {
        const text = JSON.stringify(req.turns);
        const hit = Object.entries(answers).find(([k]) => text.includes(k === 'Club ticket' ? 'DJ Nova' : 'raffle'));
        return gen([]).text === '' ? { ...gen([]), text: hit?.[1] ?? '{"events":[],"cancelled":[]}' } : gen([]);
      },
    };
    for (const p of vault.list('Factory/Evals/inbox-calendar')) if (!/Club ticket|Raffle entry/.test(p)) rmSync(vault.abs(p));
    const run = await runEvals({ vault, llm: fake, taskModel: 'big', judge: { model: 'small', effort: 'low' }, timeZone: LA, job: 'inbox-calendar' });
    const club = run.results.find((r) => r.case.name === 'Club ticket');
    const raffle = run.results.find((r) => r.case.name === 'Raffle entry');
    check('inbox evals: the right event passes', !!club?.pass, JSON.stringify(club?.verdicts));
    check('inbox evals: a raffle taken as an event fails', raffle?.pass === false && raffle.verdicts['Events right']?.why.includes('wrongly found'), raffle?.verdicts['Events right']?.why);
    check('expected events match on a word and the start', eventsVerdict(['Hack Night @ 2026-11-17T19:00'], [{ title: 'Hack Night at the Convention Center', start: '2026-11-17T19:00' }], 'events').pass && !eventsVerdict(['Hack Night @ 2026-11-17T19:00'], [{ title: 'Hack Night', start: '2026-11-18T03:00' }], 'events').pass);

    // The brief's runner: the prompt under test words the facts; code checks the shape.
    const briefFake: LLM = { retryable: () => false, async generate() { return { ...gen([]), text: '**Today**\n- 3:30 PM dentist, address unknown' }; } };
    for (const p of vault.list('Factory/Evals/brief')) if (!p.includes('Quiet day')) rmSync(vault.abs(p));
    const briefRun = await runEvals({ vault, llm: briefFake, taskModel: 'big', judge: { model: 'small', effort: 'low' }, timeZone: LA, job: 'brief' });
    check('brief evals: code catches "TBD"', briefRun.results[0]?.verdicts['No missing-detail talk']?.pass === false && briefRun.results[0]?.verdicts['Discord shape']?.pass === true, JSON.stringify(briefRun.results[0]?.verdicts));

    // The brief's shadow trial and the run note it leaves.
    vault.write('Factory/Prompts/brief v2.md', '---\njob: brief\nstatus: testing\nversion: 2\n---\n\nShorter brief.\n');
    check('the newest testing brief prompt is found for shadow', inShadow(vault, 'brief') && latestTesting(vault, 'brief')?.name === 'brief v2');
    const runNote = writeRunNote(vault, LA, { job: 'brief', title: 'Brief (shadow, brief v2)', goal: 'g', report: 'two versions', prompt: '[[Factory/Prompts/brief v2]]', shadow: true, channel: 'misc', when: new Date('2026-11-22T16:00:00Z') });
    const rn = noteFields(vault.read(runNote)!);
    check('a code job\'s shadow run is a task note', runNote === 'Squire/Tasks/2026-11-22 Brief (shadow, brief v2).md' && rn.status === 'done' && rn.job === 'brief' && rn.shadow === true && vault.read(runNote)!.includes('## Report'));

    // Photo actions as a prompt note: one action per line, still filtered by the channel's tools.
    check('photo actions round-trip through the prompt note', parsePhotoActions(PHOTO_JOB_PROMPT).length === PHOTO_ACTIONS.length && parsePhotoActions(PHOTO_JOB_PROMPT)[0]!.needs === 'google');
    const custom = photoPrompt(new Set(['notes']), '- (google) a flyer => add it\n- (notes) a menu => save it as a note');
    check('a photo prompt note replaces the actions, filtered by channel', custom.includes('a menu: save it as a note') && !custom.includes('a flyer') && photoPrompt(ALL_GROUPS).includes('a receipt or bill'));

    // Photo evals: a generated image per case, the real tool definitions, nothing run.
    const photoSeeded = seedCases(vault, 'photo');
    check('photo cases are seeded with their images', photoSeeded.length === SEED_COUNTS.photo && SEED_COUNTS.photo! >= 5 && existsSync(vault.abs('Factory/Evals/photo/Coffee receipt.png')) && loadCases(vault, 'photo').every((c) => existsSync(vault.abs(`Factory/Evals/photo/${c.input}`))));
    const seenTools: string[] = [];
    const photoFake: LLM = {
      retryable: () => false,
      async generate(_m, req) {
        seenTools.push(req.tools.map((t) => t.name).join());
        const img = req.turns[0]?.role === 'user' ? (req.turns[0].content.find((x) => x.type === 'image') as { url: string; data?: string } | undefined) : undefined;
        const url = img?.data ? img.url : '';
        if (url.includes('Coffee receipt')) return gen([{ id: 'e', name: 'log_expense', input: { date: '2026-11-18', merchant: 'Fogline Coffee', amount: 20.38, currency: 'USD', category: 'dining', note: '' } }]);
        if (url.includes('Ramen menu')) return req.turns.length === 1 ? gen([{ id: 'l', name: 'places_lists', input: {} }]) : gen([{ id: 'a', name: 'places_add', input: { query: 'Noodle Lantern, 450 Polk St' } }]);
        if (url.includes('Concert flyer')) return gen([{ id: 'n', name: 'save_note', input: { title: 'NEON HARBOR', content: 'Jan 9', mode: 'create', folder: 'Squire/Inbox', sources: [] } }]);
        if (url.includes('Recipe card')) return gen([{ id: 'r', name: 'save_note', input: { title: 'Banana Bread', content: '- 1/2 cup butter', mode: 'create', folder: 'Recipes/Pastries', sources: ['owner'] } }]);
        return { ...gen([]), text: 'A night market at Harbor Plaza on Fridays. Which Friday should I add?' };
      },
    };
    for (const p of vault.list('Factory/Evals/photo')) if (/Gym whiteboard/.test(p)) rmSync(vault.abs(p));
    const photoRun = await runEvals({ vault, llm: photoFake, taskModel: 'big', judge: { model: 'small', effort: 'low' }, timeZone: LA, job: 'photo' });
    const pr = (n: string) => photoRun.results.find((r) => r.case.name === n);
    check('photo evals: the real tools are offered', ['calendar_create_event', 'log_expense', 'places_add', 'save_note', 'training_log_set'].every((t) => seenTools[0]?.split(',').includes(t)), seenTools[0]);
    check('photo evals: a receipt logged at the total passes', !!pr('Coffee receipt')?.pass, JSON.stringify(pr('Coffee receipt')?.verdicts));
    check('photo evals: a read tool first, then the action, passes', !!pr('Ramen menu')?.pass, JSON.stringify(pr('Ramen menu')?.verdicts));
    check('photo evals: the wrong action fails', pr('Concert flyer')?.verdicts['Right action']?.pass === false && pr('Concert flyer')!.verdicts['Right action']!.why.includes('save_note'));
    check('photo evals: a misread amount fails the details', pr('Recipe card')?.verdicts['Right action']?.pass === true && pr('Recipe card')?.verdicts['Details read']?.why.includes('1/3 cup') === true, pr('Recipe card')?.verdicts['Details read']?.why);
    check('photo evals: asking for a missing date passes', !!pr('Poster with no date')?.pass, JSON.stringify(pr('Poster with no date')?.verdicts));
    check('photo verdicts: acting when it should ask fails', photoVerdicts('none', [], [{ id: 'x', name: 'calendar_create_event', input: {} }], '')['Right action']?.pass === false);

    // Training-log evals: a fresh log in a temp folder, the real training tools, sets read back.
    seedJobs(vault);
    check('the training log is a job with a v1 prompt', jobNames(vault).includes('training-log') && jobPrompt(vault, 'training-log').text.includes('training_log_set'));
    check('training cases are seeded', seedCases(vault, 'training-log').length === SEED_COUNTS['training-log'] && SEED_COUNTS['training-log']! >= 5);
    const log = (exercise: string, weight: number, reps: number, date = '') => ({ id: `${exercise}${weight}${reps}${Math.random()}`, name: 'training_log_set', input: { exercise, weight, reps, date } });
    const trainingFake: LLM = {
      retryable: () => false,
      async generate(_m, req) {
        const ask = JSON.stringify(req.turns[0]);
        const n = req.turns.length;
        if (ask.includes('bench 185x5')) return n === 1 ? gen([log('Barbell bench press', 185, 5), log('Barbell bench press', 185, 5), log('Barbell bench press', 175, 6)]) : { ...gen([]), text: 'Logged 3 sets.' };
        if (ask.includes('squat 3x5')) return n === 1 ? gen([log('Back squat', 225, 3)]) : { ...gen([]), text: 'Logged.' };
        if (ask.includes('push day done')) {
          if (n === 1) return gen([{ id: 'l', name: 'training_load_split', input: { name: 'Push day', date: '' } }]);
          if (n === 3) return gen([log('Barbell bench press', 155, 6), log('Barbell bench press', 155, 6), log('Overhead press', 95, 8)]);
          return { ...gen([]), text: 'Logged.' };
        }
        return { ...gen([]), text: 'Which exercise were those 3 sets of 135?' };
      },
    };
    for (const p of vault.list('Factory/Evals/training-log')) if (/Yesterday|Bodyweight/.test(p)) rmSync(vault.abs(p));
    const trainingRun = await runEvals({ vault, llm: trainingFake, taskModel: 'big', judge: { model: 'small', effort: 'low' }, timeZone: LA, job: 'training-log' });
    const tr = (n: string) => trainingRun.results.find((r) => r.case.name === n);
    check('training evals: three sets logged pass', !!tr('Three bench sets')?.pass, JSON.stringify(tr('Three bench sets')?.verdicts));
    check('training evals: 3x5 logged as one set fails', tr('Sets by reps notation')?.pass === false && tr('Sets by reps notation')!.verdicts['Sets logged']!.why.includes('wrongly logged back squat 225x3'), tr('Sets by reps notation')?.verdicts['Sets logged']?.why);
    check('training evals: loading the split, then logging, passes', !!tr('Nothing loaded yet')?.pass, JSON.stringify(tr('Nothing loaded yet')?.verdicts));
    check('training evals: asking with no exercise passes', !!tr('No exercise named')?.pass, JSON.stringify(tr('No exercise named')?.verdicts));
    check('training sets: another day is keyed by its date', setsVerdict(['Romanian deadlift 185x8 @ 2026-11-19'], ['romanian deadlift 185x8'], '').pass === false);

    // Code jobs aren't task jobs.
    const runner = new TaskRunner(new TaskStore(join(dir, 'tasks.json')), { llm: fake, model: 'big', fastModel: 'small', effort: 'low', timeZone: LA, reminders: new ReminderStore(join(dir, 'r.json'), LA), vault });
    let codeJob = '';
    try { runner.start({ title: 't', goal: 'g', doneWhen: 'd', deadline: new Date(Date.now() + 3600_000), channelId: 'c', channelName: 'misc', job: 'brief' }); } catch (e) { codeJob = (e as Error).message; }
    const jobEnum = ((taskTools(runner, LA, 'c', 'misc').find((t) => t.def.name === 'start_task')!.def.input_schema.properties as Record<string, { enum?: string[] }>).job!.enum ?? []).join();
    check('code jobs can\'t be started as tasks', codeJob.includes('not a task job') && jobEnum === 'none,recipe,research', jobEnum);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- governance: tools, write paths, daily caps, Factory/Registry.md ---
{
  const dir = mkdtempSync(join(tmpdir(), 'squire-gov-'));
  try {
    const vault = new Vault(join(dir, 'vault'));
    seedJobs(vault);
    scaffoldJob(vault, 'receipts', { trigger: 'manual', channel: '#misc', what: 'Log a receipt.' });
    vault.write('Factory/Prompts/receipts v1.md', vault.read('Factory/Prompts/receipts v1.md')!.replace('status: testing', 'status: production'));
    vault.write('Factory/Jobs/receipts.md', vault.read('Factory/Jobs/receipts.md')!.replace(/tools: \[\]/, 'tools: [save_note, read_note]').replace(/write_paths: \[\]/, 'write_paths: [Expenses]').replace(/daily_cap_usd: [\d.]+/, 'daily_cap_usd: 0.01').replace('shadow: true', 'shadow: false'));
    check('job notes carry a daily cap', noteFields(vault.read('Factory/Jobs/recipe.md')!).daily_cap_usd === 3 && jobSettings(vault, 'receipts').dailyCapUsd === 0.01, vault.read('Factory/Jobs/receipts.md'));
    let outside = '';
    try { checkWritePath(['Expenses'], 'receipts', 'Recipes/Meal/x.md'); } catch (err) { outside = (err as Error).message; }
    check('write paths: outside the job\'s folders is refused', outside.includes('may write only in Expenses'));
    const seen: { tools: string[]; web: number }[] = [];
    const fake: LLM = {
      retryable: () => false,
      async generate(_m, req) {
        seen.push({ tools: req.tools.map((t) => t.name), web: req.web?.maxUses ?? -1 });
        if (seen.length === 1) return { ...gen([{ id: 's', name: 'save_note', input: { path: 'Recipes/Meal/Sneaky.md', content: 'x', mode: 'create', sources: [] } }]), usage: { model: 'claude-sonnet-5-5', input: 4_000_000, output: 0, cacheRead: 0, cacheWrite: 0, webSearches: 0, webFetches: 0 } };
        return gen([{ id: 'f', name: 'finish_task', input: { outcome: 'done', report: 'ok' } }]);
      },
    };
    const activity = new ActivityLog(join(dir, 'activity'), LA);
    const runner = new TaskRunner(new TaskStore(join(dir, 'tasks.json')), { llm: fake, model: 'big', fastModel: 'small', effort: 'low', timeZone: LA, reminders: new ReminderStore(join(dir, 'r.json'), LA), vault, activity });
    runner.start({ title: 'Receipt', goal: 'log it', doneWhen: 'logged', deadline: new Date(Date.now() + 3600_000), channelId: 'c', channelName: 'misc', job: 'receipts' });
    await new Promise((r) => setTimeout(r, 50));
    const first = seen[0]!;
    check('tools: a job task gets only its allowlist', !!first && first.tools.includes('save_note') && first.tools.includes('finish_task') && !first.tools.includes('fetch_page') && !first.tools.includes('list_notes') && first.web === 0, JSON.stringify(first));
    check('write paths: the job\'s save outside them fails', vault.read('Recipes/Meal/Sneaky.md') === undefined);
    const task = runner.list()[0]!;
    check('caps: a task over its daily cap is stopped', task.status === 'failed' && String(task.result).includes('daily cap') && seen.length === 1, `${task.status}: ${task.result}`);
    check('caps: spend is logged per job', activity.read(new Date(Date.now() - 3600_000)).some((e) => e.job === 'receipts' && (e.costUsd ?? 0) > 1));
    let refused = '';
    try { runner.start({ title: 'Again', goal: 'log it', doneWhen: 'logged', deadline: new Date(Date.now() + 3600_000), channelId: 'c', channelName: 'misc', job: 'receipts' }); } catch (err) { refused = (err as Error).message; }
    check('caps: no new run starts over the cap', refused.includes('daily cap'), refused);
    check('caps: other jobs are unaffected', overCap(vault, activity, 'recipe', LA) === undefined);
    check('Factory/Registry.md is generated', updateRegistryNote(vault, activity, () => ({ passed: 4, total: 5, date: '2026-11-20' })) && /\| receipts \| task \| manual \| capable \| save_note, read_note \| Expenses \| no \| receipts v1 \| 80% \(4\/5, 2026-11-20\) \| \$0\.01 \| \$\d+\.\d\d \|/.test(vault.read(REGISTRY_NOTE)!), vault.read(REGISTRY_NOTE));
    check('an unchanged registry note is not rewritten', !updateRegistryNote(vault, activity, () => ({ passed: 4, total: 5, date: '2026-11-20' })));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- improve loop: testing vs production, before/after on the prompt ---
{
  const dir = mkdtempSync(join(tmpdir(), 'squire-improve-'));
  try {
    const vault = new Vault(dir);
    seedPrompts(vault);
    seedRecipeCases(vault);
    const cases = loadCases(vault, 'recipe').slice(0, 4);
    const res = (pass: boolean[]) => cases.map((c, i) => ({ case: c, report: '', status: 'done' as const, verdicts: { sources_linked: { pass: pass[i]!, why: pass[i] ? 'linked' : 'no link' } }, pass: pass[i]! }));
    const before = { prompt: 'recipe v1', results: res([true, false, false, true]) };
    const after = { prompt: 'recipe v2', results: res([true, true, false, true]) };
    const t1 = new Date('2026-11-20T18:00:00Z');
    const t2 = new Date('2026-11-21T18:00:00Z');
    const p1 = resultsPath(vault, 'recipe', t1, LA);
    vault.write(p1, resultsNote('recipe', 'recipe v1', before.results, t1, LA, 0.4));
    check('a results note reads back pass/fail per case', resultsFromNote(vault.read(p1)!, cases).map((r) => r.pass).join() === 'true,false,false,true');
    const testing = proposeTestingPrompt(vault, 'recipe', 'Open the link first. Always add a Sources section.', 'missing Sources');
    check('the improve loop compares a new testing prompt', testing === 'Factory/Prompts/recipe v2.md');
    const p2 = resultsPath(vault, 'recipe', t2, LA);
    vault.write(p2, resultsNote('recipe', 'recipe v2', after.results, t2, LA, 0.4));
    const cmp = comparisonPath(vault, 'recipe', 'recipe v2', t2, LA);
    const note = comparisonNote('recipe', before, after, { date: '2026-11-21', beforeNote: p1, afterNote: p2, cost: 0.8 });
    vault.write(cmp, note);
    check('the comparison says better, with fixed cases first', verdictOf(before, after) === 'better' && note.includes('2/4') && note.includes('3/4') && note.split('\n').find((l) => l.startsWith(`| ${cases[1]!.name} |`))?.includes('fixed') === true && note.indexOf('fixed') < note.indexOf(`| ${cases[0]!.name} |`), note);
    recordOnPrompt(vault, 'recipe v2', before, after, cmp, '2026-11-21');
    const f = noteFields(vault.read(testing)!);
    check('the before/after goes on the testing prompt, still testing', f.status === 'testing' && f.eval_before === 'recipe v1 2/4' && f.eval_after === '3/4' && String(f.compare_note).includes('compared'), JSON.stringify(f));
    check('it never promotes: production is unchanged', jobPrompt(vault, 'recipe').name === 'recipe v1');
    let refused = '';
    try { recordOnPrompt(vault, 'recipe v1', before, after, cmp, '2026-11-21'); } catch (err) { refused = (err as Error).message; }
    check('only a testing prompt gets compared', refused.includes('production'));
    check('a better testing prompt is ready to promote', readyToPromote(vault, 'recipe').map((r) => r.name).join() === 'recipe v2');
    check('the trend reads oldest first, without comparisons', trendLine(evalHistory(vault, 'recipe')) === '11-20 recipe v1 2/4 → 11-21 recipe v2 3/4', trendLine(evalHistory(vault, 'recipe')));
    const digest = factoryDigest(vault, new Date('2026-11-20T00:00:00Z'));
    check('the digest shows the trend and the waiting promotion', digest.includes('trend: 11-20 recipe v1 2/4') && digest.includes('testing prompt beat production: recipe v2') && digest.includes('npm run improve -- recipe'), digest);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(failures ? `\n${failures} factory check(s) failed` : '\nAll factory checks passed');
process.exit(failures ? 1 : 0);
