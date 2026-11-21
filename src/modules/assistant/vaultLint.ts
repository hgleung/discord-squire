import { BOT_FOLDER, INBOX_FOLDER, TASKS_FOLDER, type Vault } from '../../vault.js';
import { stuckTasks } from './factoryDigest.js';
import { SCHEMAS } from './ontology.js';
import { noteFields } from './taskNotes.js';
import { toLocalIso } from './time.js';

/**
 * The vault lint: code-only checks over every note (no model calls).
 *
 *   broken links     [[links]] to no note (attachments and template text skipped)
 *   ambiguous names  two notes with one name, so [[Name]] could mean either
 *   bad frontmatter  YAML that doesn't parse, or a type no schema has
 *   empty notes      nothing but whitespace
 *   old inbox        Squire/Inbox notes waiting more than a week to be filed
 *   stuck tasks      task notes "doing" for more than a day
 *
 * A fix is made only when it is unambiguous: a link to a redirect note (left
 * by a move) becomes a link to where the note went. In Squire's own notes
 * that is fixed every night; in the owner's notes it is listed, and made
 * only with --fix. Everything else is reported for the owner to decide.
 */

export const HEALTH_FOLDER = `${BOT_FOLDER}/Health`;
const INBOX_DAYS = 7;

export interface LintFix {
  path: string;
  from: string;
  to: string;
}

export interface LintReport {
  notes: number;
  broken: { path: string; link: string }[];
  ambiguous: { name: string; paths: string[] }[];
  badFrontmatter: { path: string; why: string }[];
  empty: string[];
  oldInbox: string[];
  stuck: string[];
  fixes: LintFix[];
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n?---[ \t]*(?:\r?\n|$)/;
const LINK = /!?\[\[([^\]|#^\n]+)(?:[#^][^\]|\n]*)?(?:\|[^\]\n]*)?\]\]/g;
/** Obsidian matches link targets ignoring case. */
const norm = (s: string) => s.toLowerCase().trim();
/** Squire's own notes, which the nightly run may fix without asking. */
const ownedByBot = (p: string) => p.startsWith(`${BOT_FOLDER}/`);

/** The note's text with code blocks and inline code blanked, so example links in them don't count. */
const withoutCode = (text: string) => text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');

export function lintVault(vault: Vault, now = new Date()): LintReport {
  const all = vault.list();
  const byName = new Map<string, string[]>();
  const byPath = new Map<string, string>();
  for (const p of all) {
    const bare = p.replace(/\.md$/, '');
    const name = norm(bare.split('/').at(-1)!);
    byName.set(name, [...(byName.get(name) ?? []), p]);
    byPath.set(norm(bare), p);
  }
  const report: LintReport = { notes: all.length, broken: [], ambiguous: [], badFrontmatter: [], empty: [], oldInbox: [], stuck: [], fixes: [] };
  const exact = new Set(all.map((p) => p.replace(/\.md$/, '')));
  const types = new Set<string>([...SCHEMAS.map((s) => s.type), 'redirect', 'factory-readme']);

  for (const p of all) {
    // The health notes quote broken links; they aren't checked themselves.
    if (p.startsWith(`${HEALTH_FOLDER}/`)) continue;
    const text = vault.read(p) ?? '';
    if (!text.trim()) report.empty.push(p);
    const fm = FRONTMATTER.exec(text);
    if (fm) {
      const fields = noteFields(text);
      if (fm[1]!.trim() && !Object.keys(fields).length) report.badFrontmatter.push({ path: p, why: "the frontmatter doesn't parse as YAML" });
      else if (typeof fields.type === 'string' && !types.has(fields.type) && !p.startsWith('Factory/')) report.badFrontmatter.push({ path: p, why: `type "${fields.type}" isn't one of ${SCHEMAS.map((s) => s.type).join(', ')}` });
    }
    if (p.startsWith(`${INBOX_FOLDER}/`) && now.getTime() - vault.mtime(p) > INBOX_DAYS * 86_400_000) report.oldInbox.push(p);
    // Links in frontmatter are properties (evals: "[[Factory/Evals/recipe]]"), not text to check.
    for (const m of withoutCode(text.replace(FRONTMATTER, '')).matchAll(LINK)) {
      const target = m[1]!.trim();
      if (!target || /[<>{}]/.test(target)) continue;
      // Attachments (images, PDFs) aren't notes; only .md and extension-less links are checked.
      if (/\.[a-z0-9]{2,4}$/i.test(target) && !/\.md$/i.test(target)) continue;
      const bare = target.replace(/\.md$/i, '');
      const found = bare.includes('/')
        ? byPath.get(norm(bare)) ?? [...byPath.entries()].find(([k]) => k.endsWith(`/${norm(bare)}`))?.[1]
        : byName.get(norm(bare))?.[0];
      // A link to a folder isn't a note, but it isn't broken either.
      if (!found && bare.includes('/') && vault.isDir(vault.notePath(bare))) continue;
      if (!found) {
        report.broken.push({ path: p, link: target });
        continue;
      }
      // A link to a redirect note goes to where the note moved.
      const moved = noteFields(vault.read(found) ?? '');
      if (moved.type === 'redirect' && typeof moved.moved_to === 'string') {
        const to = moved.moved_to.replace(/^\[\[|\]\]$/g, '');
        if (exact.has(to)) report.fixes.push({ path: p, from: target, to });
        continue;
      }
    }
  }
  for (const [, paths] of byName) {
    if (paths.length > 1 && !paths.every((x) => x.startsWith(`${BOT_FOLDER}/`))) report.ambiguous.push({ name: paths[0]!.split('/').at(-1)!.replace(/\.md$/, ''), paths });
  }
  report.stuck = stuckTasks(vault, now).filter((s) => s.path.startsWith(`${TASKS_FOLDER}/`)).map((s) => s.path);
  return report;
}

/** Applies fixes, each by replacing that exact link text in that note. Only the link target changes. */
export function applyFixes(vault: Vault, fixes: LintFix[]): string[] {
  const done: string[] = [];
  const byNote = new Map<string, LintFix[]>();
  for (const f of fixes) byNote.set(f.path, [...(byNote.get(f.path) ?? []), f]);
  for (const [path, list] of byNote) {
    const original = vault.read(path);
    if (original === undefined) continue;
    let text = original;
    for (const f of list) {
      const esc = f.from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const next: string = text.replace(new RegExp(`(!?\\[\\[)${esc}((?:\\.md)?(?:[#^|][^\\]\\n]*)?\\]\\])`, 'g'), `$1${f.to}$2`);
      if (next !== text) done.push(`${path}: [[${f.from}]] -> [[${f.to}]]`);
      text = next;
    }
    vault.write(path, text);
  }
  return done;
}

/** The fixes the nightly run makes by itself: only in Squire's own notes. */
export const autoFixes = (r: LintReport) => r.fixes.filter((f) => ownedByBot(f.path));

export function healthNote(r: LintReport, fixed: string[], timeZone: string, now: Date): string {
  const date = toLocalIso(now, timeZone).slice(0, 10);
  const pending = r.fixes.filter((f) => !ownedByBot(f.path));
  const problems = r.broken.length + r.ambiguous.length + r.badFrontmatter.length + r.empty.length + r.oldInbox.length + r.stuck.length + pending.length;
  const section = (title: string, lines: string[]) => (lines.length ? `\n## ${title} (${lines.length})\n\n${lines.map((l) => `- ${l}`).join('\n')}\n` : '');
  return (
    `---\ntype: note\ntags: [squire-health]\ndate: ${date}\nnotes: ${r.notes}\nproblems: ${problems}\nfixed: ${fixed.length}\n---\n\n# Vault health ${date}\n\n${r.notes} notes checked, ${problems} problem(s), ${fixed.length} fixed in Squire's own notes. Generated by the nightly lint; \`npm run vault:lint\` runs it now.\n` +
    section('Broken links', r.broken.map((b) => `[[${b.path.replace(/\.md$/, '')}]] links to [[${b.link}]], which doesn't exist`)) +
    section('Fixable in your notes (npm run vault:lint -- --fix)', pending.map((f) => `[[${f.path.replace(/\.md$/, '')}]]: \`[[${f.from}]]\` → \`[[${f.to}]]\``)) +
    section('Same name, two notes', r.ambiguous.map((a) => `${a.name}: ${a.paths.map((x) => `\`${x}\``).join(', ')}`)) +
    section('Frontmatter', r.badFrontmatter.map((b) => `[[${b.path.replace(/\.md$/, '')}]]: ${b.why}`)) +
    section('Empty notes', r.empty.map((p) => `[[${p.replace(/\.md$/, '')}]]`)) +
    section(`In ${INBOX_FOLDER} for over a week`, r.oldInbox.map((p) => `[[${p.replace(/\.md$/, '')}]]`)) +
    section('Tasks doing for over a day', r.stuck.map((p) => `[[${p.replace(/\.md$/, '')}]]`)) +
    section('Fixed', fixed) +
    (problems ? '' : '\nNothing to fix.\n')
  );
}

/** The nightly run: lint, fix Squire's own notes, write the health note. Returns its path. */
export function nightlyHealth(vault: Vault, timeZone: string, now = new Date()): string {
  const first = lintVault(vault, now);
  const fixed = applyFixes(vault, autoFixes(first));
  const report = fixed.length ? lintVault(vault, now) : first;
  const path = `${HEALTH_FOLDER}/${toLocalIso(now, timeZone).slice(0, 10)}.md`;
  vault.write(path, healthNote(report, fixed, timeZone, now));
  return path;
}
