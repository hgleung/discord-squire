import type { Vault } from '../../vault.js';
import type { CaseResult, EvalCase, EvalSummary } from './evals.js';
import { jobSettings, PROMPTS_FOLDER, promptNotes } from './factory.js';
import { noteFields, setNoteFields, wikiLink } from './taskNotes.js';
import { toLocalIso } from './time.js';

/**
 * The improve loop's last step: a testing prompt is run on the job's evals
 * beside the production prompt, and the before/after goes in a comparison
 * note in the job's results folder and on the testing prompt note itself
 * (eval_before, eval_after, compared). The prompt stays status: testing:
 * promoting it is the owner's call, made by setting status: production on it
 * (and retired on the old one).
 */

export interface EvalRun {
  prompt: string;
  results: CaseResult[];
}

const rate = (r: EvalRun) => `${r.results.filter((x) => x.pass).length}/${r.results.length}`;
const passed = (r: EvalRun) => r.results.filter((x) => x.pass).length;

export function verdictOf(before: EvalRun, after: EvalRun): 'better' | 'same' | 'worse' {
  const d = passed(after) / Math.max(1, after.results.length) - passed(before) / Math.max(1, before.results.length);
  return d > 0 ? 'better' : d < 0 ? 'worse' : 'same';
}

/** The comparison note: pass rates, then case by case, fixed and broken first. */
export function comparisonNote(job: string, before: EvalRun, after: EvalRun, o: { date: string; beforeNote: string; afterNote: string; cost: number }): string {
  const byName = new Map(before.results.map((r) => [r.case.name, r]));
  const rows = after.results.map((a) => {
    const b = byName.get(a.case.name);
    const change = !b ? 'new case' : a.pass && !b.pass ? 'fixed' : !a.pass && b.pass ? 'broke' : '';
    const failed = Object.entries(a.verdicts).filter(([, v]) => !v.pass).map(([k, v]) => `${k}: ${v.why}`).join('; ');
    return { change, line: `| ${a.case.name} | ${b ? (b.pass ? '✅' : '❌') : '—'} | ${a.pass ? '✅' : '❌'} | ${change} | ${failed.replace(/\|/g, '/')} |` };
  });
  rows.sort((x, y) => Number(!x.change) - Number(!y.change));
  const v = verdictOf(before, after);
  return (
    `---\ntype: note\ntags: [squire-eval, squire-compare]\njob: ${job}\nbefore: ${JSON.stringify(before.prompt)}\nafter: ${JSON.stringify(after.prompt)}\ndate: ${o.date}\nbefore_passed: ${passed(before)}\nafter_passed: ${passed(after)}\ntotal: ${after.results.length}\nverdict: ${v}\ncost_usd: ${o.cost.toFixed(4)}\n---\n\n` +
    `# ${job}: ${after.prompt} vs ${before.prompt}\n\n**${before.prompt}** (production): ${rate(before)} · **${after.prompt}** (testing): ${rate(after)} · ${v}.\n\n` +
    `${v === 'better' ? `If you agree, promote it: set \`status: production\` on [[${PROMPTS_FOLDER}/${after.prompt}]] and \`status: retired\` on [[${PROMPTS_FOLDER}/${before.prompt}]]. Squire doesn't do that itself.` : 'Not better on these cases, so keep the production prompt. The testing prompt stays as it is for another try.'}\n\n` +
    `Full results: [[${o.beforeNote.replace(/\.md$/, '')}]] and [[${o.afterNote.replace(/\.md$/, '')}]].\n\n| Case | Before | After | Change | What failed after |\n|---|---|---|---|---|\n${rows.map((r) => r.line).join('\n')}\n`
  );
}

/** Puts the before/after on the testing prompt note, keeping it testing. Refuses a prompt that isn't testing. */
export function recordOnPrompt(vault: Vault, promptName: string, before: EvalRun, after: EvalRun, comparePath: string, date: string): string {
  const note = promptNotes(vault).find((n) => n.name.toLowerCase() === promptName.toLowerCase());
  if (!note) throw new Error(`No prompt note called "${promptName}".`);
  if (note.status !== 'testing') throw new Error(`${note.name} is ${note.status || 'not testing'}; only testing prompts get compared.`);
  const text = vault.read(note.path)!;
  vault.write(note.path, setNoteFields(text, { eval_before: `${before.prompt} ${rate(before)}`, eval_after: `${rate(after)}`, compared: date, compare_note: wikiLink(comparePath), status: 'testing' }));
  return note.path;
}

/** The path for a comparison note in the job's results folder (where Squire may write). */
export function comparisonPath(vault: Vault, job: string, after: string, when: Date, timeZone: string): string {
  const base = `${jobSettings(vault, job).evals}/results/${toLocalIso(when, timeZone).slice(0, 10)} ${after} compared`;
  let rel = `${base}.md`;
  for (let i = 2; vault.read(rel) !== undefined; i++) rel = `${base} ${i}.md`;
  return rel;
}

/** A job's pass-rate history as one line, oldest first: "11-14 recipe v1 6/10 → 11-21 recipe v2 8/10". */
export function trendLine(history: EvalSummary[]): string {
  return [...history]
    .reverse()
    .filter((h) => !h.path.endsWith(' compared.md') && !/ compared \d+\.md$/.test(h.path))
    .map((h) => `${h.date.slice(5, 10)} ${h.prompt} ${h.passed}/${h.total}`)
    .join(' → ');
}

/** Testing prompts whose comparison beat production: waiting for the owner to promote. */
export function readyToPromote(vault: Vault, job: string): { name: string; before: string; after: string }[] {
  return promptNotes(vault)
    .filter((n) => n.job === job && n.status === 'testing')
    .map((n) => ({ n, f: noteFields(vault.read(n.path) ?? '') }))
    .filter(({ f }) => f.eval_before && f.eval_after)
    .filter(({ f }) => {
      const [bp, bt] = String(f.eval_before).split(' ').at(-1)!.split('/').map(Number);
      const [ap, at] = String(f.eval_after).split('/').map(Number);
      return at! > 0 && bt! > 0 && ap! / at! > bp! / bt!;
    })
    .map(({ n, f }) => ({ name: n.name, before: String(f.eval_before), after: String(f.eval_after) }));
}

/** A results note read back as pass or fail per case: all a comparison needs from a run it reuses. */
export function resultsFromNote(text: string, cases: EvalCase[]): CaseResult[] {
  return cases.map((c) => {
    const row = text.split('\n').find((l) => l.startsWith(`| ${c.name} |`)) ?? '';
    return { case: c, report: '', status: 'done', verdicts: {}, pass: row.trim().endsWith('**pass** |') };
  });
}
