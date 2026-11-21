/**
 * The improve loop: a testing prompt against production, on the job's evals.
 *
 *   npm run improve -- recipe "recipe v2"         estimate the cost, then stop
 *   npm run improve -- recipe "recipe v2" --yes   run both, write the before/after
 *
 * Writes both results notes and a comparison note in Factory/Evals/<job>/results/,
 * and puts eval_before / eval_after on the testing prompt. It never makes a
 * prompt production: that's yours to do. Production's result from today is
 * reused when there is one, so it isn't paid for twice.
 */
import 'dotenv/config';
import { Vault } from '../../vault.js';
import { AnthropicLLM } from './anthropic.js';
import { estimateCost, evalHistory, loadCases, resultsNote, resultsPath, runEvals } from './evals.js';
import { seedCases } from './codeEvals.js';
import { jobNames, jobPrompt, jobSettings } from './factory.js';
import { comparisonNote, comparisonPath, recordOnPrompt, resultsFromNote, verdictOf } from './improve.js';
import { systemTimeZone, toLocalIso } from './time.js';
import { dollars } from './usage.js';

const env = (name: string) => process.env[name]?.trim() || undefined;
const [job, testing] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const yes = process.argv.includes('--yes');
const root = env('OBSIDIAN_VAULT');
if (!root) {
  console.error('OBSIDIAN_VAULT is not set.');
  process.exit(1);
}
const vault = new Vault(root);
if (!job || !testing || !jobNames(vault).includes(job)) {
  console.error(`Usage: npm run improve -- <job> "<job> vN" [--yes]. Jobs: ${jobNames(vault).join(', ')}.`);
  process.exit(1);
}
const timeZone = env('ASSISTANT_TIMEZONE') ?? systemTimeZone();
const s = jobSettings(vault, job);
const taskModel = s.tier === 'fast' ? (env('ASSISTANT_MODEL') ?? 'claude-haiku-5-5') : (env('ASSISTANT_TASK_MODEL') ?? 'claude-sonnet-5-5');
const judgeModel = env('ASSISTANT_MODEL') ?? 'claude-haiku-5-5';
seedCases(vault, job);
const cases = loadCases(vault, job);
const production = jobPrompt(vault, job).name;
const candidate = jobPrompt(vault, job, testing).name;
if (candidate === production) {
  console.error(`"${testing}" is the production prompt; name a testing one.`);
  process.exit(1);
}
const today = toLocalIso(new Date(), timeZone).slice(0, 10);
const reuse = evalHistory(vault, job).find((h) => h.prompt === production && h.date.slice(0, 10) === today && h.total === cases.length);
const per = s.kind === 'code' ? estimateCost(1, judgeModel, judgeModel) / 8 : estimateCost(1, taskModel, judgeModel);
const runs = reuse ? 1 : 2;
console.log(`${cases.length} ${job} case(s): "${candidate}"${reuse ? ` (production "${production}" reused from ${reuse.path})` : ` and production "${production}"`}. Estimated cost: about ${dollars(per * cases.length * runs)}.`);
if (!yes) {
  console.log('Nothing run. Add --yes to run.');
  process.exit(0);
}
const llm = new AnthropicLLM();
const run = async (prompt: string) => {
  const r = await runEvals({ vault, llm, taskModel, judge: { model: judgeModel, effort: 'low' }, timeZone, job, prompt, onCase: (c, i, n) => console.log(`[${prompt} ${i + 1}/${n}] ${c.pass ? 'pass' : 'FAIL'}  ${c.case.name}`) });
  const when = new Date();
  const path = resultsPath(vault, job, when, timeZone);
  vault.write(path, resultsNote(job, r.prompt, r.results, when, timeZone, r.cost));
  return { ...r, path };
};
const before = reuse ? { prompt: production, results: resultsFromNote(vault.read(reuse.path) ?? '', cases), cost: 0, path: reuse.path } : await run(production);
const after = await run(candidate);
const now = new Date();
const compare = comparisonPath(vault, job, candidate, now, timeZone);
vault.write(compare, comparisonNote(job, before, after, { date: toLocalIso(now, timeZone), beforeNote: before.path, afterNote: after.path, cost: before.cost + after.cost }));
recordOnPrompt(vault, candidate, before, after, compare, today);
console.log(`\n${production}: ${before.results.filter((r) => r.pass).length}/${before.results.length} · ${candidate}: ${after.results.filter((r) => r.pass).length}/${after.results.length} · ${verdictOf(before, after)}. Cost about ${dollars(before.cost + after.cost)}.\nComparison: ${compare}\n${candidate} stays testing; set status: production on it yourself if you want it.`);
