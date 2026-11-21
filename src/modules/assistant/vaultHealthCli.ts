/**
 * The weekly vault-health factory, by hand.
 *
 *   npm run vault:health                    list the candidate notes and the estimated cost; nothing runs
 *   npm run vault:health -- --yes           propose tidy-ups now, into Squire/Health/<date> proposals.md
 *   npm run vault:health -- --apply "<note>" make the ticked archives and filings in that note (moves only)
 *
 * The bot runs it on the weekly review's day. Proposing changes nothing.
 */
import 'dotenv/config';
import { Vault } from '../../vault.js';
import { AnthropicLLM } from './anthropic.js';
import { codeJobPrompt } from './codeJobs.js';
import { estimateCost } from './evals.js';
import { jobSettings } from './factory.js';
import { systemTimeZone } from './time.js';
import { dollars } from './usage.js';
import { applyProposals, candidates, VAULT_HEALTH_PROMPT, weeklyVaultHealth } from './vaultHealth.js';

const env = (name: string) => process.env[name]?.trim() || undefined;
const args = process.argv.slice(2);
const root = env('OBSIDIAN_VAULT');
if (!root) {
  console.error('OBSIDIAN_VAULT is not set.');
  process.exit(1);
}
const vault = new Vault(root);
const timeZone = env('ASSISTANT_TIMEZONE') ?? systemTimeZone();
const applyAt = args.indexOf('--apply');
if (applyAt >= 0) {
  const note = args[applyAt + 1];
  if (!note) {
    console.error('Name the proposals note: npm run vault:health -- --apply "Squire/Health/<date> proposals.md"');
    process.exit(1);
  }
  const { done, skipped } = applyProposals(vault, note);
  console.log(`${done.length} moved${done.length ? `:\n${done.map((d) => `  ${d}`).join('\n')}` : ''}`);
  for (const s of skipped) console.log(`  skipped ${s}`);
  process.exit(0);
}
const model = jobSettings(vault, 'vault-health').tier === 'capable' ? (env('ASSISTANT_TASK_MODEL') ?? 'claude-sonnet-5-5') : (env('ASSISTANT_MODEL') ?? 'claude-haiku-5-5');
const list = candidates(vault);
// One call; about a sixteenth of a judged task case.
console.log(`${list.length} candidate note(s). One call on ${model}, estimated ${dollars(estimateCost(1, model, model) / 8)}.`);
if (!args.includes('--yes')) {
  console.log(list.slice(0, 20).map((l) => `  ${l}`).join('\n'));
  console.log('Nothing run. Add --yes to propose tidy-ups.');
  process.exit(0);
}
const prompt = codeJobPrompt(vault, 'vault-health') ?? { text: VAULT_HEALTH_PROMPT, name: 'built-in' };
const run = await weeklyVaultHealth(vault, new AnthropicLLM(), { model, effort: 'low' }, prompt, timeZone);
console.log(`${run.proposals.length} proposal(s) in ${run.path}. Nothing was changed.`);
