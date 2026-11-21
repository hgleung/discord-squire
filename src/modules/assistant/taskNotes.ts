import { parse, parseDocument, stringify } from 'yaml';
import { noteFileName, TASKS_FOLDER, type Vault } from '../../vault.js';
import type { Task, TaskStatus } from './tasks.js';
import type { ProposedNote } from './notes.js';
import { toLocalIso } from './time.js';

/**
 * Background tasks as notes in Squire/Tasks. Each task's note carries its
 * state in frontmatter, so the vault shows what is queued, running and done:
 *
 *   status: todo | doing | done | failed
 *   output: "[[Recipes/Meal/Kai Jeow]]"   the note the task wrote, if any
 *   outcome, requested, finished, channel, tags   as before
 *
 * A note the owner writes by hand with `status: todo` and a Goal / Done when
 * body is picked up and run like a task started from chat. Their note stays
 * theirs: only its frontmatter changes, and the report is added at the end.
 */

export type NoteStatus = 'todo' | 'doing' | 'done' | 'failed';
export const NOTE_STATUSES: NoteStatus[] = ['todo', 'doing', 'done', 'failed'];

/** A task's status as its note shows it. Couldn't finish and cancelled count as failed; outcome keeps the detail. */
export function noteStatus(status: TaskStatus): NoteStatus {
  if (status === 'done') return 'done';
  if (status === 'gave_up' || status === 'cancelled' || status === 'failed') return 'failed';
  return 'doing';
}

const OUTCOME: Partial<Record<TaskStatus, string>> = { done: 'done', gave_up: "couldn't finish", cancelled: 'cancelled', failed: 'failed' };

/** An Obsidian link to a vault-relative note path. */
export const wikiLink = (rel: string) => `[[${rel.replace(/\.md$/, '')}]]`;

/**
 * Discord-only markdown made plain for Obsidian: "-# " subtext lines lose
 * their marker, which Obsidian would read as a list item holding a tag.
 */
const forObsidian = (text: string) => text.replace(/^-# /gm, '');

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n?---[ \t]*(?:\r?\n|$)/;

/** A note's frontmatter fields; {} when it has none or they don't parse. */
export function noteFields(text: string): Record<string, unknown> {
  const m = FRONTMATTER.exec(text);
  if (!m) return {};
  try {
    const fields = parse(m[1]!) as unknown;
    return fields && typeof fields === 'object' && !Array.isArray(fields) ? (fields as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The note without its frontmatter. */
export const noteBody = (text: string) => text.replace(FRONTMATTER, '');

/**
 * Sets frontmatter fields on a note, keeping its other fields, their order and
 * its body exactly. Undefined values are left alone. Throws when the existing
 * frontmatter doesn't parse, rather than lose it.
 */
export function setNoteFields(text: string, fields: Record<string, unknown>): string {
  const m = FRONTMATTER.exec(text);
  const doc = parseDocument(m ? m[1]! : '');
  if (doc.errors.length) throw new Error(`its frontmatter doesn't parse: ${doc.errors[0]!.message}`);
  for (const [key, value] of Object.entries(fields)) if (value !== undefined) doc.set(key, value);
  const body = m ? text.slice(m[0].length) : `\n${text}`;
  return `---\n${doc.toString().trimEnd()}\n---\n${body}`;
}

/**
 * Writes a task's note: a new one under Squire/Tasks the first time (never on
 * top of another note), then the same note as the task moves along. Returns
 * its path.
 */
export function writeTaskNote(vault: Vault, task: Task, timeZone: string): string {
  const ended = noteStatus(task.status) !== 'doing';
  const finished = ended ? toLocalIso(new Date(task.finishedAt ?? Date.now()), timeZone) : undefined;
  const fields = {
    status: noteStatus(task.status),
    output: task.output ? wikiLink(task.output) : undefined,
    outcome: ended ? OUTCOME[task.status] : undefined,
    requested: toLocalIso(new Date(task.createdAt), timeZone),
    finished,
    channel: `#${task.channelName}`,
    job: task.job,
    prompt: task.job ? (task.promptNote ? wikiLink(task.promptNote) : task.prompt) : undefined,
    shadow: task.shadow || undefined,
    proposed: task.proposal ? wikiLink(task.proposal.path) : undefined,
  };
  const proposal = ended && task.proposal ? proposalSection(task.proposal) : '';
  const report = ended && task.result ? `## Report\n\n${forObsidian(task.result)}\n${proposal ? `\n${proposal}` : ''}` : '';

  if (task.note && task.ownNote) {
    // The owner's own note: frontmatter only, and the report added once at the end.
    const existing = vault.read(task.note) ?? '';
    let next = setNoteFields(existing, fields);
    if (report && !existing.includes(report.trim())) next = `${next.trimEnd()}\n\n${report}`;
    vault.write(task.note, next);
    return task.note;
  }

  if (!task.note) {
    const base = `${TASKS_FOLDER}/${toLocalIso(new Date(task.createdAt), timeZone).slice(0, 10)} ${noteFileName(task.title)}`;
    let rel = `${base}.md`;
    for (let i = 2; vault.read(rel) !== undefined; i++) rel = `${base} ${i}.md`;
    task.note = rel;
  }
  const clean = Object.fromEntries(Object.entries({ ...fields, tags: ['squire-task'] }).filter(([, v]) => v !== undefined));
  vault.write(
    task.note,
    `---\n${stringify(clean).trimEnd()}\n---\n\n# ${task.title}\n\n**Goal:** ${task.goal}\n\n**Done when:** ${task.doneWhen}\n${report ? `\n${report}` : ''}`,
  );
  return task.note;
}

/** A hand-written task note waiting to run. */
export interface TodoNote {
  path: string;
  title: string;
  goal: string;
  doneWhen: string;
  fields: Record<string, unknown>;
}

const LABELS = ['Goal', 'Done[ -]?when'];
const labelRe = (label: string) => new RegExp(`^(?:#+\\s*)?(?:\\*\\*)?${label}\\b(?:\\*\\*)?\\s*:?\\s*(?:\\*\\*)?\\s*(.*)$`, 'i');

/** The text after "Goal:" or "**Goal:**" to the end of that paragraph, or under a "## Goal" heading to the next heading. */
function section(body: string, label: string): string {
  const lines = body.split(/\r?\n/);
  const re = labelRe(label);
  const at = lines.findIndex((l) => re.test(l.trim()));
  if (at < 0) return '';
  const first = re.exec(lines[at]!.trim())![1]!;
  const out = [first];
  for (const line of lines.slice(at + 1)) {
    if (/^#/.test(line.trim()) || LABELS.some((l) => labelRe(l).test(line.trim()))) break;
    // "Goal: ..." runs to the end of its paragraph; a "## Goal" heading, to the next heading.
    if (first && !line.trim()) break;
    out.push(line);
  }
  return out.join('\n').trim();
}

/** Notes in Squire/Tasks marked status: todo, with what they ask for. Goal or Done when may be empty; the caller says so. */
export function todoNotes(vault: Vault): TodoNote[] {
  const out: TodoNote[] = [];
  for (const path of vault.list(TASKS_FOLDER)) {
    const text = vault.read(path) ?? '';
    const fields = noteFields(text);
    if (String(fields.status ?? '').trim().toLowerCase() !== 'todo') continue;
    const body = noteBody(text);
    const title = /^#\s+(.+)$/m.exec(body)?.[1]?.trim() || path.split('/').at(-1)!.replace(/\.md$/, '');
    out.push({ path, title, goal: section(body, LABELS[0]!), doneWhen: section(body, LABELS[1]!), fields });
  }
  return out;
}

/**
 * Gives task notes written before status existed their status, from their
 * outcome. Adds the one field and changes nothing else; running it again does
 * nothing. Returns the notes it changed.
 */
export function migrateTaskNotes(vault: Vault): string[] {
  const changed: string[] = [];
  for (const path of vault.list(TASKS_FOLDER)) {
    const text = vault.read(path) ?? '';
    const fields = noteFields(text);
    if (fields.status !== undefined || fields.outcome === undefined) continue;
    try {
      vault.write(path, setNoteFields(text, { status: fields.outcome === 'done' ? 'done' : 'failed' }));
      changed.push(path);
    } catch (err) {
      console.error(`[tasks] could not add a status to ${path}:`, err);
    }
  }
  return changed;
}

/** How a shadow run's proposed note sits in its task note, so it can be promoted from the vault later. */
export function proposalSection(p: ProposedNote & { base?: string }): string {
  return (
    `## Proposed note\n\nShadow mode: this would ${p.mode === 'create' ? 'be saved as' : p.mode === 'append' ? 'be added to' : 'replace'} ${wikiLink(p.path)}, and nothing was written. ` +
    'Say "promote" in Discord to save it.\n\n' +
    `<!-- squire:proposal path=${JSON.stringify(p.path)} mode="${p.mode}"${p.base ? ` base="${p.base}"` : ''} -->\n\`\`\`\`markdown\n${p.content.trimEnd()}\n\`\`\`\`\n<!-- /squire:proposal -->\n`
  );
}

/** The proposed note in a task note, if it has one. */
export function readProposal(text: string): (ProposedNote & { base?: string }) | undefined {
  const m = /<!-- squire:proposal path=("(?:[^"\\]|\\.)*") mode="(create|append|replace)"(?: base="([0-9a-f]+)")? -->\r?\n````markdown\r?\n([\s\S]*?)\r?\n````\r?\n<!-- \/squire:proposal -->/.exec(text);
  if (!m) return undefined;
  return { path: JSON.parse(m[1]!) as string, mode: m[2] as ProposedNote['mode'], ...(m[3] ? { base: m[3] } : {}), content: `${m[4]}\n` };
}
