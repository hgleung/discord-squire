import { BOT_FOLDER, INBOX_FOLDER, TRAINING_FOLDER, WORKOUTS_FOLDER, type Vault } from '../../vault.js';
import { FACTORY_FOLDER, GENERATED_FOLDERS } from './factoryGuard.js';
import type { LLM, ModelOptions, Usage } from './llm.js';
import { noteFields } from './taskNotes.js';
import { toLocalIso } from './time.js';
import { HEALTH_FOLDER, lintVault } from './vaultLint.js';

/**
 * The weekly vault-health factory: from a short list of candidate notes
 * (stale and unlinked, tiny, sitting in the inbox, sharing a name), one cheap
 * model call proposes what to do with each: archive, file, merge or update.
 * The proposals are written as a checklist note in Squire/Health and nothing
 * else changes. The owner ticks what they want; `npm run vault:health --
 * --apply <note>` then makes only the ticked archives and filings, through
 * Vault.move. Merges and updates are left for the owner to ask Squire for in
 * chat, since they rewrite notes.
 */

export const ARCHIVE_FOLDER = 'Archive';
const STALE_DAYS = 180;
const TINY_CHARS = 120;
const MAX_CANDIDATES = 120;
/** Never proposed for anything: the training log, Factory/, generated folders, Squire's own working notes. */
const PROTECTED = [TRAINING_FOLDER, WORKOUTS_FOLDER, FACTORY_FOLDER, ...GENERATED_FOLDERS, `${BOT_FOLDER}/Tasks`, `${BOT_FOLDER}/Migrations`, ARCHIVE_FOLDER];
const isProtected = (p: string) => PROTECTED.some((f) => p === f || p.startsWith(`${f}/`)) || p === `${BOT_FOLDER}/Ontology.md`;

export const VAULT_HEALTH_PROMPT = `You review a short list of notes from the owner's Obsidian vault and propose tidy-ups. The owner decides; nothing you write is applied without them ticking it.
Each candidate line is: path · last modified · size · type · how many notes link to it · why it's listed.
Answer with one line per proposal, nothing else, in exactly one of these forms:
- archive | <path> | <why, a few words>
- file | <path> -> <folder> | <why>
- merge | <path> + <path> -> <path to keep> | <why>
- update | <path> | <what to update>
Rules:
- Propose only for paths in the list, copied exactly. Leave a note alone when you're not sure; no proposal is better than a wrong one.
- archive: stale notes nobody links to that look finished or abandoned (old drafts, one-off lists, empty stubs). Never archive a recipe, a trip still ahead, or a note others link to.
- file: a note in ${INBOX_FOLDER} or notes/ whose topic clearly has a folder already (recipes in Recipes/<subfolder>, trips in Travel/<Trip>, places in Cafes or Places, project ideas in proj-ideas).
- merge: two notes on the same thing (same name in two folders, a "v2" next to the original). Keep the newer or fuller one.
- update: a note that is clearly out of date from its own line (a trip whose dates have passed still marked planning).
- At most 15 proposals. If nothing needs doing, answer "none".`;

export interface Proposal {
  action: 'archive' | 'file' | 'merge' | 'update';
  paths: string[];
  target?: string;
  why: string;
}

/** Notes that might need tidying, one line each, for the model. Reads only. */
export function candidates(vault: Vault, now = new Date()): string[] {
  const all = vault.list().filter((p) => !isProtected(p));
  const inbound = new Map<string, number>();
  const texts = new Map(vault.list().map((p) => [p, vault.read(p) ?? ''] as const));
  for (const [, text] of texts) {
    for (const m of text.matchAll(/\[\[([^\]|#^\n]+)/g)) {
      const key = m[1]!.trim().toLowerCase().replace(/\.md$/, '');
      inbound.set(key, (inbound.get(key) ?? 0) + 1);
    }
  }
  const lint = lintVault(vault, now);
  const shared = new Set(lint.ambiguous.flatMap((a) => a.paths));
  const out: string[] = [];
  for (const p of all) {
    const text = texts.get(p) ?? '';
    const bare = p.replace(/\.md$/, '');
    const links = (inbound.get(bare.toLowerCase()) ?? 0) + (inbound.get(bare.split('/').at(-1)!.toLowerCase()) ?? 0);
    const days = Math.floor((now.getTime() - vault.mtime(p)) / 86_400_000);
    const why: string[] = [];
    if (days >= STALE_DAYS && links === 0) why.push(`untouched ${days} days, nothing links to it`);
    if (text.replace(/^---[\s\S]*?---/, '').trim().length < TINY_CHARS) why.push('almost empty');
    if (p.startsWith(`${INBOX_FOLDER}/`) || p.startsWith('notes/')) why.push('not filed');
    if (shared.has(p)) why.push('another note has the same name');
    if (/\b(v\d+|draft|copy|old)\b/i.test(bare.split('/').at(-1)!)) why.push('looks like a version or draft');
    if (!why.length) continue;
    const type = noteFields(text).type;
    out.push(`${p} · modified ${toLocalIso(new Date(vault.mtime(p)), 'UTC').slice(0, 10)} · ${text.length} chars · ${type ? `type ${String(type)}` : 'no type'} · linked from ${links} · ${why.join('; ')}`);
    if (out.length >= MAX_CANDIDATES) break;
  }
  return out;
}

/** The model's lines as proposals. Lines that don't fit a form are dropped. */
export function parseProposals(text: string): Proposal[] {
  const out: Proposal[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/^\s*[-*]\s*(\[[ x]\]\s*)?/i, '').trim();
    const [action, what, ...rest] = line.split('|').map((s) => s.trim());
    const why = rest.join('|').trim();
    if (!what) continue;
    const a = action?.toLowerCase();
    if (a === 'archive' || a === 'update') out.push({ action: a, paths: [what], why });
    else if (a === 'file') {
      const [path, folder] = what.split('->').map((s) => s.trim());
      if (path && folder) out.push({ action: 'file', paths: [path], target: folder.replace(/\/+$/, ''), why });
    } else if (a === 'merge') {
      const [from, keep] = what.split('->').map((s) => s.trim());
      const paths = (from ?? '').split('+').map((s) => s.trim()).filter(Boolean);
      if (paths.length >= 2 && keep) out.push({ action: 'merge', paths, target: keep, why });
    }
  }
  return out;
}

/** Drops proposals for notes that don't exist, protected notes, and moves onto a note that's there. */
export function validProposals(vault: Vault, proposals: Proposal[]): Proposal[] {
  return proposals.filter((p) => {
    if (p.paths.some((x) => vault.read(x) === undefined || isProtected(x))) return false;
    if (p.action === 'file') return !!p.target && !isProtected(`${p.target}/x`) && vault.read(`${p.target}/${p.paths[0]!.split('/').at(-1)}`) === undefined;
    if (p.action === 'merge') return p.paths.includes(p.target!);
    if (p.action === 'archive') return vault.read(`${ARCHIVE_FOLDER}/${p.paths[0]}`) === undefined;
    return true;
  });
}

const link = (p: string) => `[[${p.replace(/\.md$/, '')}]]`;
const line = (p: Proposal) => {
  if (p.action === 'archive') return `archive ${link(p.paths[0]!)} → \`${ARCHIVE_FOLDER}/${p.paths[0]}\` — ${p.why}`;
  if (p.action === 'file') return `file ${link(p.paths[0]!)} → \`${p.target}/\` — ${p.why}`;
  if (p.action === 'merge') return `merge ${p.paths.map(link).join(' + ')} into ${link(p.target!)} — ${p.why} (ask Squire in chat)`;
  return `update ${link(p.paths[0]!)} — ${p.why} (ask Squire in chat)`;
};

export function proposalsNote(proposals: Proposal[], o: { date: string; prompt: string; candidates: number }): string {
  return `---\ntype: note\ntags: [squire-health]\njob: vault-health\nprompt: ${JSON.stringify(o.prompt)}\ndate: ${o.date}\nproposals: ${proposals.length}\n---\n\n# Vault tidy-up proposals ${o.date}\n\nFrom ${o.candidates} candidate notes. Nothing has been changed. Tick what you want, then run \`npm run vault:health -- --apply "${HEALTH_FOLDER}/${o.date} proposals.md"\`: it makes the ticked archives and filings with a move (never a delete) and marks them done. Merges and updates rewrite notes, so ask Squire for those in chat.\n\n${proposals.map((p) => `- [ ] ${line(p)}`).join('\n') || 'Nothing to tidy this week.'}\n`;
}

/** Runs the job once: candidates, one model call, the checklist note. Returns its path, or undefined when there were no candidates. */
export async function weeklyVaultHealth(
  vault: Vault,
  llm: LLM,
  model: ModelOptions,
  prompt: { text: string; name: string },
  timeZone: string,
  now = new Date(),
): Promise<{ path?: string; proposals: Proposal[]; usage?: Usage }> {
  const list = candidates(vault, now);
  const date = toLocalIso(now, timeZone).slice(0, 10);
  const path = `${HEALTH_FOLDER}/${date} proposals.md`;
  if (!list.length) {
    vault.write(path, proposalsNote([], { date, prompt: prompt.name, candidates: 0 }));
    return { path, proposals: [] };
  }
  const gen = await llm.generate(model, {
    system: prompt.text,
    tools: [],
    turns: [{ role: 'user', content: [{ type: 'text', text: `Today is ${date}.\n\nCandidates:\n${list.join('\n')}` }] }],
    web: { maxUses: 0 },
  });
  const proposals = validProposals(vault, parseProposals(gen.text));
  vault.write(path, proposalsNote(proposals, { date, prompt: prompt.name, candidates: list.length }));
  return { path, proposals, usage: gen.usage };
}

/**
 * Makes the ticked archives and filings in a proposals note, each with
 * Vault.move, and marks each line it made. Unticked lines, merges and updates
 * are left. Returns what it did.
 */
export function applyProposals(vault: Vault, notePath: string): { done: string[]; skipped: string[] } {
  const text = vault.read(notePath);
  if (text === undefined) throw new Error(`No note at ${notePath}.`);
  const done: string[] = [];
  const skipped: string[] = [];
  const next = text.replace(/^- \[x\] (archive|file) \[\[([^\]]+)\]\] → `([^`]+)`(.*)$/gim, (whole, action: string, note: string, dest: string, rest: string) => {
    if (rest.includes('✓ done')) return whole;
    const from = `${note}.md`;
    const to = action.toLowerCase() === 'archive' ? dest : `${dest.replace(/\/+$/, '')}/${from.split('/').at(-1)}`;
    try {
      if (isProtected(from)) throw new Error('protected');
      vault.move(from, to);
      done.push(`${from} -> ${to}`);
      return `${whole} ✓ done`;
    } catch (err) {
      skipped.push(`${from}: ${err instanceof Error ? err.message : String(err)}`);
      return whole;
    }
  });
  if (next !== text) vault.write(notePath, next);
  return { done, skipped };
}
