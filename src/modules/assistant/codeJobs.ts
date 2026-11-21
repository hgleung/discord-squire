import { stringify } from 'yaml';
import { noteFileName, TASKS_FOLDER, type Vault } from '../../vault.js';
import { jobPrompt, jobSettings, promptNotes, type JobPrompt } from './factory.js';
import { toLocalIso } from './time.js';

/**
 * Jobs the bot's own code runs (the brief's wording, inbox events, photo
 * actions): the facts and the actions stay in code, and only the prompt is
 * versioned in the vault. These helpers read a code job's prompt and
 * settings, and write a run's shadow result as a task note.
 */

/** The job's production prompt, or undefined to use the built-in one (no vault, or the note can't be read). */
export function codeJobPrompt(vault: Vault | undefined, job: string): JobPrompt | undefined {
  if (!vault) return undefined;
  try {
    const p = jobPrompt(vault, job);
    return p.path ? p : undefined;
  } catch (err) {
    console.error(`[factory] ${job}: using the built-in prompt:`, err instanceof Error ? err.message : err);
    return undefined;
  }
}

/** The newest testing prompt for a job, to try in shadow beside production. */
export function latestTesting(vault: Vault, job: string): JobPrompt | undefined {
  const t = promptNotes(vault)
    .filter((n) => n.job === job && n.status === 'testing' && n.text)
    .sort((a, b) => b.version - a.version)[0];
  return t ? { job, name: t.name, path: t.path, version: t.version, status: 'testing', text: t.text } : undefined;
}

/** Whether the job is in shadow mode. */
export const inShadow = (vault: Vault | undefined, job: string) => !!vault && jobSettings(vault, job).shadow;

/**
 * Writes a code job's run as a task note in Squire/Tasks (status done, the
 * job and its prompt, the result as the report), so its shadow results sit
 * with the other task reports. Never overwrites a note. Returns its path.
 */
export function writeRunNote(
  vault: Vault,
  timeZone: string,
  r: { job: string; title: string; goal: string; report: string; prompt?: string; shadow: boolean; channel: string; when?: Date },
): string {
  const when = r.when ?? new Date();
  const iso = toLocalIso(when, timeZone);
  const base = `${TASKS_FOLDER}/${iso.slice(0, 10)} ${noteFileName(r.title)}`;
  let path = `${base}.md`;
  for (let i = 2; vault.read(path) !== undefined; i++) path = `${base} ${i}.md`;
  const fields = { status: 'done', outcome: 'done', requested: iso, finished: iso, channel: `#${r.channel}`, job: r.job, ...(r.prompt ? { prompt: r.prompt } : {}), ...(r.shadow ? { shadow: true } : {}), tags: ['squire-task'] };
  vault.write(path, `---\n${stringify(fields).trimEnd()}\n---\n\n# ${r.title}\n\n**Goal:** ${r.goal}\n\n**Done when:** the run is done.\n\n## Report\n\n${r.report.trim()}\n`);
  return path;
}
