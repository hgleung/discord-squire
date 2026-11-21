/**
 * Building factories cheaply.
 *
 *   npm run factory -- new <job> [--trigger manual|event|scheduled] [--channel misc] [--what "what it does"]
 *   npm run factory -- list
 *   npm run factory -- trend <job>        pass rates over time
 *
 * "new" writes the job's note in Factory/Jobs/, a first prompt in
 * Factory/Prompts/ (status: testing, until you make it production) and an
 * example eval case, and never overwrites anything. The job then runs as a
 * background task: put job: <job> on a task note, or ask for it in Discord.
 */
import 'dotenv/config';
import { Vault } from '../../vault.js';
import { jobNames, jobPrompt, jobSettings, scaffoldJob, type Trigger } from './factory.js';
import { evalHistory } from './evals.js';
import { updateRegistry } from './factoryDigest.js';
import { readyToPromote, trendLine } from './improve.js';

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const root = process.env.OBSIDIAN_VAULT?.trim();
if (!root) {
  console.error('OBSIDIAN_VAULT is not set.');
  process.exit(1);
}
const vault = new Vault(root);
const [command, name] = args;
if (command === 'new' && name) {
  const wrote = scaffoldJob(vault, name, { trigger: flag('trigger') as Trigger | undefined, channel: flag('channel'), what: flag('what') });
  console.log(`Wrote:\n${wrote.map((p) => `  ${p}`).join('\n')}\nNext: write the prompt, replace the example case with 5 real ones, run npm run eval -- ${name}, then set the prompt's status to production.`);
} else if (command === 'list') {
  for (const job of jobNames(vault)) {
    const s = jobSettings(vault, job);
    let prompt = '';
    try {
      prompt = jobPrompt(vault, job).name;
    } catch {
      prompt = '(no production prompt)';
    }
    const last = evalHistory(vault, job)[0];
    console.log(`${job.padEnd(14)} ${s.kind}/${s.trigger} #${s.channel} shadow ${s.shadow ? 'on ' : 'off'} ${s.tier.padEnd(8)} ${prompt.padEnd(22)} ${last ? `${last.passed}/${last.total} on ${last.date.slice(0, 10)}` : 'no eval yet'}`);
  }
} else if (command === 'registry') {
  // The first time, the README gets marker comments around its table: shown as a dry run unless --apply.
  const apply = args.includes('--apply');
  const { before, after, wrote } = updateRegistry(vault, apply);
  if (!before) console.log('No Factory/README.md.');
  else if (before === after) console.log('The registry is up to date.');
  else if (wrote) console.log('Updated the job registry in Factory/README.md.');
  else {
    const a = before.split('\n');
    const b = after.split('\n');
    let i = 0;
    while (i < a.length && a[i] === b[i]) i++;
    let j = 0;
    while (j < a.length - i && a[a.length - 1 - j] === b[b.length - 1 - j]) j++;
    console.log(`Dry run: Factory/README.md would change at line ${i + 1}:\n${a.slice(i, a.length - j).map((l) => `- ${l}`).join('\n')}\n${b.slice(i, b.length - j).map((l) => `+ ${l}`).join('\n')}\nNothing else in the note changes. Run again with --apply to write it.`);
  }
} else if (command === 'trend' && name) {
  // Every eval of a job, oldest first, and any testing prompt that beat production.
  console.log(trendLine(evalHistory(vault, name)) || `No evals of ${name} yet: npm run eval -- ${name}`);
  for (const r of readyToPromote(vault, name)) console.log(`${r.name} beat production (${r.after} vs ${r.before}); set status: production on it to promote.`);
} else {
  console.error('Usage: npm run factory -- new <job> [--trigger manual|event|scheduled] [--channel <name>] [--what "<what it does>"] | list | registry [--apply]');
  process.exit(1);
}
