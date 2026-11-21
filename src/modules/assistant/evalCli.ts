/**
 * Runs a factory job's eval cases and writes the scored results to the vault.
 *
 *   npm run eval -- recipe                      estimate the cost, then stop
 *   npm run eval -- recipe --yes                run every case on the production prompt
 *   npm run eval -- recipe --prompt "recipe v2" --yes
 *
 * Each case runs as a real job task on the task model, in a sandbox copy of
 * Recipes/ and Factory/Prompts/, so nothing is written to Recipes/. The judge
 * is the chat model (the cheapest tier) at low effort. Results go to
 * Factory/Evals/<job>/results/<date>.md.
 */
import 'dotenv/config';
import { Vault } from '../../vault.js';
import { AnthropicLLM } from './anthropic.js';
import { CHECK_LABELS, estimateCost, evalHistory, loadCases, resultsNote, resultsPath, runEvals, type CheckName } from './evals.js';
import { seedCases } from './codeEvals.js';
import { jobNames, jobPrompt, jobSettings } from './factory.js';
import { systemTimeZone } from './time.js';
import { updateRegistry } from './factoryDigest.js';
import { REGISTRY_NOTE, updateRegistryNote } from './governance.js';
import { ActivityLog } from './activity.js';
import { fileURLToPath } from 'node:url';
import { dollars } from './usage.js';

const env = (name: string) => process.env[name]?.trim() || undefined;
const args = process.argv.slice(2);
const job = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--prompt');
const promptAt = args.indexOf('--prompt');
const prompt = promptAt >= 0 ? args[promptAt + 1] : undefined;
const yes = args.includes('--yes');

const root = env('OBSIDIAN_VAULT');
if (!root) {
  console.error('OBSIDIAN_VAULT is not set.');
  process.exit(1);
}
const vault = new Vault(root);
if (!job || !jobNames(vault).includes(job)) {
  console.error(`Usage: npm run eval -- <job> [--prompt "<job> vN"] [--yes]. Jobs: ${jobNames(vault).join(', ')}.`);
  process.exit(1);
}
const timeZone = env('ASSISTANT_TIMEZONE') ?? systemTimeZone();
// The job's own tier, from its job note: capable runs on the task model, fast on the chat model.
const taskModel = jobSettings(vault, job).tier === 'fast' ? (env('ASSISTANT_MODEL') ?? 'claude-haiku-5-5') : (env('ASSISTANT_TASK_MODEL') ?? 'claude-sonnet-5-5');
const judgeModel = env('ASSISTANT_MODEL') ?? 'claude-haiku-5-5';

const seeded = seedCases(vault, job);
if (seeded.length) console.log(`Wrote ${seeded.length} starter eval cases for ${job}.`);
const cases = loadCases(vault, job);
const using = jobPrompt(vault, job, prompt).name;
// A code job is one cheap call per case; a task job is a whole task.
const estimate = jobSettings(vault, job).kind === 'code' ? estimateCost(cases.length, judgeModel, judgeModel) / 8 : estimateCost(cases.length, taskModel, judgeModel);
console.log(`${cases.length} ${job} case(s), prompt "${using}", jobs on ${taskModel}, judged by ${judgeModel}. Estimated cost: about ${dollars(estimate)}.`);
if (!yes) {
  console.log('Nothing run. Add --yes to run them.');
  process.exit(0);
}

const run = await runEvals({
  vault,
  llm: new AnthropicLLM(),
  taskModel,
  judge: { model: judgeModel, effort: 'low' },
  timeZone,
  job,
  prompt,
  onCase: (r, i, n) => {
    const failed = Object.entries(r.verdicts).filter(([, v]) => v && !v.pass).map(([k]) => CHECK_LABELS[k as CheckName]);
    console.log(`[${i + 1}/${n}] ${r.pass ? 'pass' : 'FAIL'}  ${r.case.name}${failed.length ? `  (${failed.join(', ')})` : ''}${r.status === 'error' ? `  error: ${r.report}` : ''}`);
  },
});
const when = new Date();
const path = resultsPath(vault, job, when, timeZone);
vault.write(path, resultsNote(job, run.prompt, run.results, when, timeZone, run.cost));
if (updateRegistry(vault).wrote) console.log('Updated the job registry in Factory/README.md.');
const activity = new ActivityLog(env('ACTIVITY_DIR') ?? fileURLToPath(new URL('../../../data/activity', import.meta.url)), timeZone);
if (updateRegistryNote(vault, activity, (j) => evalHistory(vault, j)[0])) console.log(`Updated ${REGISTRY_NOTE}.`);
const passed = run.results.filter((r) => r.pass).length;
console.log(`\n${passed}/${run.results.length} passed on "${run.prompt}". Cost about ${dollars(run.cost)}. Results: ${path}`);
