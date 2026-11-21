import { stringify } from 'yaml';
import { TASKS_FOLDER, type Vault } from '../../vault.js';
import { evalHistory, type EvalSummary } from './evals.js';
import { FACTORY_README, hasRegistryMarkers, jobNames, jobPrompt, jobSettings, PROMPTS_FOLDER, promptNotes, registryTable, withRegistry } from './factory.js';
import { pageKey } from './readLog.js';
import { noteBody, noteFields, readProposal } from './taskNotes.js';
import { readyToPromote, trendLine } from './improve.js';

/**
 * The factories' part of the nightly review: per job, the latest eval pass
 * rate and its trend, the cases and real runs that failed a checklist item,
 * and shadow proposals waiting. A fix to a prompt goes in as a new "testing"
 * prompt note (proposeTestingPrompt), never as an edit to production.
 */

const pct = (s: EvalSummary) => (s.total ? `${s.passed}/${s.total} (${Math.round((s.passed / s.total) * 100)}%)` : 'no cases');
const URL_RE = /https?:\/\/[^\s)<>\]]+/g;

export interface JobRun {
  path: string;
  title: string;
  status: string;
  finished: string;
  output?: string;
  proposed?: string;
  promoted: boolean;
  /** Checklist items code could check on a real run and found failing. */
  failed: string[];
}

/** The job's real runs finished since a time, from their task notes, with what code can check on them. */
export function jobRuns(vault: Vault, job: string, since: Date): JobRun[] {
  const out: JobRun[] = [];
  for (const path of vault.list(TASKS_FOLDER)) {
    const text = vault.read(path) ?? '';
    const f = noteFields(text);
    if (String(f.job ?? '') !== job) continue;
    const finished = String(f.finished ?? '');
    if (!finished || new Date(finished) < since) continue;
    const link = (v: unknown) => (v ? String(v).replace(/^\[\[|\]\]$/g, '') : undefined);
    const output = link(f.output);
    const proposed = link(f.proposed);
    const failed: string[] = [];
    if (f.status === 'failed') failed.push(`the task ended ${String(f.outcome ?? 'failed')}`);
    const target = output ?? proposed;
    const note = output ? vault.read(`${output}.md`) : readProposal(text)?.content;
    if (!target && f.status === 'done') failed.push('no recipe note saved or proposed');
    // Sources: the link the task was given has to be in the note it wrote.
    const given = (/\*\*Goal:\*\*([^\n]*)/.exec(noteBody(text))?.[1] ?? '').match(URL_RE) ?? [];
    if (note !== undefined && given.length && !given.some((g) => (note.match(URL_RE) ?? []).some((l) => pageKey(l) === pageKey(g)))) {
      failed.push(`Sources linked: the link it was given (${given[0]}) isn't in the note`);
    }
    out.push({ path, title: /^#\s+(.+)$/m.exec(text)?.[1] ?? path, status: String(f.status ?? ''), finished, output, proposed, promoted: !!f.promoted, failed });
  }
  return out.sort((a, b) => a.finished.localeCompare(b.finished));
}

/** The next free version number for a job's prompts. */
export function nextVersion(vault: Vault, job: string): number {
  return Math.max(0, ...promptNotes(vault).filter((n) => n.job === job).map((n) => n.version)) + 1;
}

/**
 * Writes a proposed prompt change as a new "<job> vN.md" with status: testing.
 * Never edits an existing prompt note, production or not. Returns its path.
 */
export function proposeTestingPrompt(vault: Vault, job: string, text: string, why: string): string {
  if (!jobNames(vault).includes(job)) throw new Error(`No job called "${job}".`);
  if (!text.trim()) throw new Error('The prompt is empty.');
  const version = nextVersion(vault, job);
  const path = `${PROMPTS_FOLDER}/${job} v${version}.md`;
  if (vault.read(path) !== undefined) throw new Error(`${path} already exists.`);
  const base = jobPrompt(vault, job).name;
  const fields = { job, process_step: promptNotes(vault).find((n) => n.job === job)?.processStep || job, status: 'testing', version, based_on: base, why: why.trim() };
  vault.write(path, `---\n${stringify(fields).trimEnd()}\n---\n\n${text.trim()}\n`);
  return path;
}

/** The Factories section of review:digest. */
export function factoryDigest(vault: Vault, since: Date): string {
  const jobs = jobNames(vault);
  const out = [`===== Factories: ${jobs.length} =====`];
  for (const job of jobs) {
    let prompt;
    try {
      prompt = jobPrompt(vault, job);
    } catch (err) {
      out.push(`${job} · ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const testing = promptNotes(vault).filter((n) => n.job === job && n.status === 'testing').map((n) => n.name);
    out.push(`${job} · production prompt "${prompt.name}" · shadow ${jobSettings(vault, job).shadow ? 'on' : 'off'}${testing.length ? ` · testing: ${testing.join(', ')}` : ''}`);
    const history = evalHistory(vault, job);
    const latest = history[0];
    if (!latest) {
      out.push(`  no eval yet: npm run eval -- ${job}`);
    } else {
      const trend = history.slice(1, 4).map((h) => `${h.date.slice(0, 10)} ${h.prompt} ${pct(h)}`);
      out.push(`  latest eval ${latest.date.slice(0, 10)} on "${latest.prompt}": ${pct(latest)}${trend.length ? ` · before: ${trend.join('; ')}` : ''}`);
      for (const f of latest.failed) out.push(`  - eval case failed: ${f.case}: ${f.items.join(' | ')}`);
    }
    if (history.length > 1) out.push(`  trend: ${trendLine(history.slice(0, 8))}`);
    for (const r of readyToPromote(vault, job)) out.push(`  - testing prompt beat production: ${r.name} (${r.after} vs ${r.before}); waiting for the owner to promote it`);
    const runs = jobRuns(vault, job, since);
    out.push(`  runs since: ${runs.length}`);
    for (const r of runs.filter((r) => r.failed.length)) out.push(`  - run failed a checklist item: ${r.title} (${r.path}): ${r.failed.join(' | ')}`);
    const waiting = runs.filter((r) => r.proposed && !r.promoted);
    for (const r of waiting) out.push(`  - shadow proposal waiting for the owner: ${r.proposed} (${r.path})`);
    out.push(
      `  To fix a failure in the prompt: write the whole new prompt to a file, then npm run prompt:propose -- ${job} <file> "<what it fixes>" (creates ${job} v${nextVersion(vault, job)} as testing; never edit the production prompt), then npm run improve -- ${job} "${job} v${nextVersion(vault, job)}" --yes to eval it beside production and record the before/after on it. Promoting is the owner's call.`,
    );
  }
  return out.join('\n');
}

/** Task notes still "doing" more than a day after they were requested: stuck, or waiting longer than they should. */
export function stuckTasks(vault: Vault, now = new Date()): { path: string; since: string }[] {
  const out: { path: string; since: string }[] = [];
  for (const path of vault.list(TASKS_FOLDER)) {
    const f = noteFields(vault.read(path) ?? '');
    if (String(f.status ?? '') !== 'doing') continue;
    const since = f.requested ? new Date(String(f.requested)).getTime() : vault.mtime(path);
    if (Number.isFinite(since) && now.getTime() - since > 86_400_000) out.push({ path, since: new Date(since).toISOString() });
  }
  return out;
}

/** The Factories facts for the Sunday weekly review: pass rates, failed items, proposals waiting, stuck tasks. */
export function weeklyFactoryFacts(vault: Vault, now = new Date()): string {
  const lines: string[] = [];
  for (const job of jobNames(vault)) {
    const latest = evalHistory(vault, job)[0];
    const failed = latest ? [...new Set(latest.failed.flatMap((f) => f.items.map((i) => i.split(':')[0]!)))] : [];
    const waiting = jobRuns(vault, job, new Date(now.getTime() - 30 * 86_400_000)).filter((r) => r.proposed && !r.promoted);
    lines.push(
      `- ${job}: ${latest ? `last eval ${pct(latest)} on "${latest.prompt}" (${latest.date.slice(0, 10)})` : 'no eval yet'}` +
        `${failed.length ? `; failed items: ${failed.join(', ')}` : ''}` +
        `${waiting.length ? `; ${waiting.length} shadow result(s) waiting for approval: ${waiting.map((w) => w.proposed).join(', ')}` : ''}`,
    );
  }
  const stuck = stuckTasks(vault, now);
  if (stuck.length) lines.push(`- Tasks "doing" for more than 24 hours: ${stuck.map((s) => s.path.split('/').at(-1)!.replace(/\.md$/, '')).join(', ')}`);
  return lines.length ? `Factories (computed by the app; quote as given):\n${lines.join('\n')}` : '';
}

/**
 * Regenerates the job registry table in Factory/README.md. Only the table
 * between the marker comments changes. With no markers yet, nothing is
 * written unless apply is set: the caller shows the change as a dry run
 * first. Returns the README before and after, and whether it wrote.
 */
export function updateRegistry(vault: Vault, apply = false): { before: string; after: string; wrote: boolean } {
  const before = vault.read(FACTORY_README);
  if (before === undefined) return { before: '', after: '', wrote: false };
  const table = registryTable(vault, (job) => evalHistory(vault, job)[0]);
  const after = withRegistry(before, table);
  if (after === before || (!hasRegistryMarkers(before) && !apply)) return { before, after, wrote: false };
  return { before, after, wrote: vault.write(FACTORY_README, after) };
}
