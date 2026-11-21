/**
 * The ontology migration: adds type fields where a folder already says what a
 * note is, links trip notes to their trip, writes an index note for each trip
 * and project folder, and files typed notes out of Squire/Inbox and notes/.
 *
 *   npm run vault:migrate             dry run: lists every change, writes nothing
 *   npm run vault:migrate -- --apply  makes them, and logs them to Squire/Migrations/
 *
 * It only adds: no field that is set is changed, no body is rewritten, nothing
 * is deleted, and moves go through Vault.move (which refuses to overwrite).
 */
import 'dotenv/config';
import { Vault } from '../../vault.js';
import { applyMigration, describe, planMigration } from './ontology.js';
import { systemTimeZone } from './time.js';

const root = process.env.OBSIDIAN_VAULT?.trim();
if (!root) {
  console.error('OBSIDIAN_VAULT is not set.');
  process.exit(1);
}
const vault = new Vault(root);
const timeZone = process.env.ASSISTANT_TIMEZONE?.trim() || systemTimeZone();
const plan = planMigration(vault, timeZone);
if (!process.argv.includes('--apply')) {
  console.log(plan.length ? plan.map(describe).join('\n') : 'Nothing to change.');
  console.log(`\n${plan.length} change(s). Dry run: nothing written. Add --apply to make them.`);
} else {
  const { done, skipped, log } = applyMigration(vault, plan, timeZone);
  console.log(`${done.length} change(s) made, ${skipped.length} skipped. Log: ${log}`);
  for (const s of skipped) console.log(`  ${s}`);
}
