/**
 * The vault lint, now. Code only: no model calls, no cost.
 *
 *   npm run vault:lint          list the problems and the fixes it could make; writes nothing
 *   npm run vault:lint -- --fix make those fixes (links to moved notes only) and write today's Squire/Health note
 *
 * The bot runs it every night too, fixing only its own notes.
 */
import 'dotenv/config';
import { Vault } from '../../vault.js';
import { applyFixes, healthNote, HEALTH_FOLDER, lintVault } from './vaultLint.js';
import { systemTimeZone, toLocalIso } from './time.js';

const root = process.env.OBSIDIAN_VAULT?.trim();
if (!root) {
  console.error('OBSIDIAN_VAULT is not set.');
  process.exit(1);
}
const vault = new Vault(root);
const timeZone = process.env.ASSISTANT_TIMEZONE?.trim() || systemTimeZone();
const now = new Date();
const report = lintVault(vault, now);
const list = (title: string, lines: string[]) => lines.length && console.log(`\n${title} (${lines.length}):\n${lines.map((l) => `  ${l}`).join('\n')}`);
console.log(`${report.notes} notes checked.`);
list('Broken links', report.broken.map((b) => `${b.path}: [[${b.link}]]`));
list('Same name, two notes', report.ambiguous.map((a) => `${a.name}: ${a.paths.join(', ')}`));
list('Frontmatter', report.badFrontmatter.map((b) => `${b.path}: ${b.why}`));
list('Empty notes', report.empty);
list('Inbox notes over a week old', report.oldInbox);
list('Tasks doing for over a day', report.stuck);
list('Fixes', report.fixes.map((f) => `${f.path}: [[${f.from}]] -> [[${f.to}]]`));
if (!process.argv.includes('--fix')) {
  console.log(`\nDry run: nothing written.${report.fixes.length ? ' Add --fix to make the fixes above.' : ''}`);
} else {
  const fixed = applyFixes(vault, report.fixes);
  const path = `${HEALTH_FOLDER}/${toLocalIso(now, timeZone).slice(0, 10)}.md`;
  vault.write(path, healthNote(fixed.length ? lintVault(vault, now) : report, fixed, timeZone, now));
  console.log(`\n${fixed.length} fix(es) made. Wrote ${path}.`);
}
