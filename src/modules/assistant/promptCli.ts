/**
 * Proposes a change to a factory job's prompt as a new testing version. It
 * never edits an existing prompt note; promoting to production is the owner's
 * call, after the new version beats the current one on the evals.
 *
 *   npm run prompt:propose -- recipe new-prompt.md "File soups in Soup"
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { Vault } from '../../vault.js';
import { proposeTestingPrompt } from './factoryDigest.js';

const [job, file, why = ''] = process.argv.slice(2);
const root = process.env.OBSIDIAN_VAULT?.trim();
if (!job || !file || !root) {
  console.error('Usage: npm run prompt:propose -- <job> <prompt file> "<what it fixes>" (needs OBSIDIAN_VAULT).');
  process.exit(1);
}
const path = proposeTestingPrompt(new Vault(root), job, readFileSync(file, 'utf8'), why);
console.log(`Wrote ${path} (status: testing). Try it: npm run eval -- ${job} --prompt "${path.split('/').at(-1)!.replace(/\.md$/, '')}" --yes`);
