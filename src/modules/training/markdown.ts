import YAML from 'yaml';
import { format, parseISO } from 'date-fns';
import { noteFileName } from '../../vault.js';
import { InvalidPlanFileError } from '../../../lib/planFile.js';
import { MUSCLE_LABEL, lookupMuscles, type MuscleGroup } from '../../../lib/muscles.js';
import { toISODate } from '../../../lib/dateUtils.js';
import { CURRENT_VERSION } from '../../../lib/types.js';
import type {
  DayLog,
  Exercise,
  ExerciseColor,
  PlanData,
  QuickAddExercise,
  SetEntry,
  TemplateExercise,
  WeightUnit,
  WorkoutTemplate,
} from '../../../lib/types.js';

/**
 * The training log as markdown in the Obsidian vault, which is its source of
 * truth: the owner reads and edits it in Obsidian, and the web app and Discord
 * see the same thing. Pure text in and out; the store owns the disk.
 *
 * Parsing is lenient because these files are hand-edited: anything missing
 * falls back to a sensible default rather than failing. Ids aren't stored —
 * they're derived from position, so they're stable only between writes, which
 * is all the callers need.
 */

export const TRAINING_NOTE = 'Training.md';
export const WORKOUTS = 'Workouts';
export const SPLITS = 'Splits';
/** "Workout" in the name keeps day files clear of the vault's own daily notes ("2026-11-12.md"). */
export const DAY_FILE = /^(\d{4}-\d{2}-\d{2}) Workout\.md$/;

/** Files Squire may delete when they drop out of the plan. Anything else in the folder is the owner's. */
export function isOwnedFile(rel: string): boolean {
  const [folder, name, ...rest] = rel.split('/');
  if (!name || rest.length > 0) return false;
  return folder === SPLITS ? name.endsWith('.md') : folder === WORKOUTS && DAY_FILE.test(name);
}

const COLORS: readonly string[] = ['green', 'yellow', 'blue', 'orange', 'purple', 'pink', 'teal', 'red'] satisfies ExerciseColor[];

// ---------------------------------------------------------------- render

/** Every file of the folder for a plan, keyed by folder-relative path with forward slashes. */
export function renderPlan(plan: PlanData): Map<string, string> {
  const files = new Map<string, string>();
  files.set(TRAINING_NOTE, renderTraining(plan));

  // Split notes are named after the split, so two splits whose names collide
  // as file names (Windows ignores case) need a suffix to keep both.
  const splitBase = new Map<string, string>();
  const taken = new Set<string>();
  plan.templates.forEach((t, order) => {
    let base = noteFileName(t.name);
    for (let n = 2; taken.has(base.toLowerCase()); n++) base = `${noteFileName(t.name)} (${n})`;
    taken.add(base.toLowerCase());
    if (!splitBase.has(t.id)) splitBase.set(t.id, base);
    files.set(`${SPLITS}/${base}.md`, renderSplit(t, order));
  });

  for (const [date, day] of Object.entries(plan.days)) {
    // The key becomes a file name, so it must be exactly a date and nothing that could escape the folder.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(parseISO(date).getTime())) {
      throw new InvalidPlanFileError(`the day "${date}" isn't a YYYY-MM-DD date.`);
    }
    if (day.exercises.length === 0) continue;
    const template = plan.templates.find((t) => t.id === day.templateId);
    const split = template && { name: template.name, base: splitBase.get(template.id)! };
    files.set(`${WORKOUTS}/${date} Workout.md`, renderDay(date, day, split, plan.config.unit));
  }
  return files;
}

function renderTraining(plan: PlanData): string {
  const { planName, unit, createdDate } = plan.config;
  return [
    frontmatter([['plan', planName], ['unit', unit], ['started', createdDate]]),
    `# ${oneLine(planName)}`,
    '',
    '*Squire keeps this folder: workouts are in Workouts/, splits in Splits/.*',
    '',
    '## Quick add',
    ...plan.quickAddExercises.flatMap((q) => ['', renderExercise(q, '###')]),
    '',
  ].join('\n');
}

function renderSplit(t: WorkoutTemplate, order: number): string {
  const fields: [string, unknown][] = [['id', t.id], ['order', order]];
  if (t.isBuiltin) fields.push(['builtin', true]);
  fields.push(['tags', ['workout-split']]);
  return [
    frontmatter(fields),
    `# ${oneLine(t.name)}`,
    ...(t.description.trim() ? ['', t.description.trim()] : []),
    ...t.exercises.flatMap((e) => ['', renderExercise(e, '##')]),
    '',
  ].join('\n');
}

function renderDay(date: string, day: DayLog, split: { name: string; base: string } | undefined, unit: WeightUnit): string {
  const fields: [string, unknown][] = [['date', date]];
  // A property link, so the split note's backlinks list every day it was trained.
  if (split) fields.push(['split', `[[${split.base}]]`]);
  fields.push(['tags', ['workout']]);
  return [
    frontmatter(fields),
    `# ${oneLine(split?.name ?? 'Workout')} · ${format(parseISO(date), 'EEE d MMM yyyy')}`,
    ...day.exercises.flatMap((e) => ['', renderExercise(e, '##', unit)]),
    '',
  ].join('\n');
}

function renderExercise(e: TemplateExercise & { sets?: SetEntry[]; note?: string }, hashes: string, unit?: WeightUnit): string {
  const meta = [`Target: ${e.targetSets}${e.targetReps ? ` × ${e.targetReps}` : ''}`];
  for (const [key, muscles] of [['Primary', e.primaryMuscles], ['Secondary', e.secondaryMuscles]] as const) {
    if (muscles.length) meta.push(`${key}: ${muscles.map((m) => MUSCLE_LABEL[m] ?? m).join(', ')}`);
  }
  meta.push(`Color: ${e.color}`);

  const lines = [`${hashes} ${oneLine([e.emoji, e.name].filter(Boolean).join(' '))}`.trimEnd(), meta.join(' · ')];
  // Task checkboxes, so ticking one in Obsidian marks the set done.
  const sets = (e.sets ?? []).map(
    (s) => `- [${s.completed ? 'x' : ' '}] ${s.weight == null ? '—' : `${s.weight} ${unit}`} × ${s.reps ?? '—'}`,
  );
  if (sets.length) lines.push('', ...sets);
  if (e.note?.trim()) lines.push('', e.note);
  return lines.join('\n');
}

function frontmatter(fields: [string, unknown][]): string {
  const lines = fields.map(([k, v]) => {
    const value = Array.isArray(v) ? `[${v.join(', ')}]` : typeof v === 'string' ? YAML.stringify(v, { lineWidth: 0 }).trimEnd() : String(v);
    return `${k}: ${value}`;
  });
  return ['---', ...lines, '---'].join('\n');
}

const oneLine = (s: string) => s.replace(/\s*\n\s*/g, ' ');

// ---------------------------------------------------------------- parse

/**
 * Reads a folder's files (folder-relative path → content) back into a plan.
 * A file that can't be read is reported through `warn` and listed in
 * `failed`, and the rest of the log still loads.
 */
export function parsePlan(
  files: ReadonlyMap<string, string>,
  warn: (message: string) => void = () => {},
): { plan: PlanData; failed: string[] } {
  const failed: string[] = [];
  const attempt = <T>(rel: string, fn: (note: Note) => T): T | undefined => {
    try {
      return fn(readNote(files.get(rel)!, (m) => warn(`${rel}: ${m}`)));
    } catch (err) {
      failed.push(rel);
      warn(`Skipped ${rel}: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  };

  const splits: { base: string; order: number; template: WorkoutTemplate }[] = [];
  for (const rel of files.keys()) {
    const base = /^Splits\/([^/]+)\.md$/.exec(rel)?.[1];
    if (base === undefined) continue;
    const split = attempt(rel, (note) => parseSplit(base, note));
    if (split) splits.push(split);
  }
  splits.sort((a, b) => a.order - b.order || a.base.localeCompare(b.base));

  // A split added by hand has no id, and a copied file repeats one; either way each needs its own.
  const ids = new Set<string>();
  for (const s of splits) {
    let id = s.template.id;
    for (let n = 2; ids.has(id); n++) id = `${s.template.id}-${n}`;
    ids.add(id);
    s.template.id = id;
  }

  // Day notes link a split by file name; a hand-typed link may use the split's own name instead.
  const splitByLink = new Map<string, string>();
  for (const s of splits) splitByLink.set(s.base.toLowerCase(), s.template.id);
  for (const s of splits) if (!splitByLink.has(s.template.name.toLowerCase())) splitByLink.set(s.template.name.toLowerCase(), s.template.id);

  const days: Record<string, DayLog> = {};
  for (const rel of [...files.keys()].sort()) {
    const date = /^Workouts\/([^/]+)$/.exec(rel)?.[1].match(DAY_FILE)?.[1];
    if (date === undefined) continue;
    const day = attempt(rel, (note) => parseDay(date, note, splitByLink));
    if (day && day.exercises.length > 0) days[date] = day;
  }

  const config = (files.has(TRAINING_NOTE) && attempt(TRAINING_NOTE, parseTraining)) || {
    config: { planName: 'My training log', unit: 'lb' as const, createdDate: toISODate(new Date()) },
    quickAddExercises: [],
  };

  return {
    plan: { version: CURRENT_VERSION, ...config, days, templates: splits.map((s) => s.template) },
    failed,
  };
}

function parseTraining(note: Note): Pick<PlanData, 'config' | 'quickAddExercises'> {
  const { preamble, blocks } = sections(note.lines, 2);
  const started = String(note.data.started ?? '');
  const quick = blocks.find((b) => b.title.trim().toLowerCase() === 'quick add');
  return {
    config: {
      planName: String(note.data.plan ?? '').trim() || heading1(preamble) || 'My training log',
      unit: note.data.unit === 'kg' ? 'kg' : 'lb',
      createdDate: /^\d{4}-\d{2}-\d{2}$/.test(started) ? started : toISODate(new Date()),
    },
    quickAddExercises: quick
      ? sections(quick.body, 3).blocks.map((b, i): QuickAddExercise => ({ id: `qa-${i}`, ...parseExercise(b).exercise }))
      : [],
  };
}

function parseSplit(base: string, note: Note): { base: string; order: number; template: WorkoutTemplate } {
  const { preamble, blocks } = sections(note.lines, 2);
  const name = heading1(preamble) || base;
  const fallbackId = `tpl-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'split'}`;
  const id = typeof note.data.id === 'string' && note.data.id.trim() ? note.data.id.trim() : fallbackId;
  const order = Number(note.data.order);
  const template: WorkoutTemplate = {
    id,
    name,
    description: trimBlankEdges(preamble.filter((l) => !HEADING.test(l))).join('\n'),
    exercises: blocks.map((b) => parseExercise(b).exercise),
  };
  if (note.data.builtin === true || note.data.builtin === 'true') template.isBuiltin = true;
  return { base, order: Number.isFinite(order) ? order : Infinity, template };
}

function parseDay(date: string, note: Note, splitByLink: Map<string, string>): DayLog {
  const exercises = sections(note.lines, 2).blocks.map((b, i): Exercise => {
    const { exercise, sets, note: text } = parseExercise(b);
    const id = `${date}-e${i}`;
    return {
      id,
      ...exercise,
      sets: sets.map((s, j) => ({ id: `${id}-s${j}`, ...s })),
      ...(text !== undefined && { note: text }),
    };
  });
  const link = linkTarget(note.data.split);
  const templateId = link === undefined ? undefined : splitByLink.get(link.toLowerCase());
  return { date, exercises, ...(templateId !== undefined && { templateId }) };
}

/** `[[Push day]]`, `[[Splits/Push day|Push]]`, or the nested arrays YAML makes of an unquoted link → "Push day". */
function linkTarget(value: unknown): string | undefined {
  const raw = Array.isArray(value) ? (value as unknown[]).flat(Infinity)[0] : value;
  if (typeof raw !== 'string') return undefined;
  const target = raw.replace(/^\s*\[\[|\]\]\s*$/g, '').split(/[|#]/)[0].trim().replace(/\.md$/i, '');
  return target.split('/').pop() || undefined;
}

const META_LINE = /^\s*(target|primary|secondary|colou?r)\s*:/i;
const SET_LINE = /^\s*[-*+]\s+\[(.)\]\s*(.*?)\s*$/;
const EMOJI =
  /^((?:\p{Extended_Pictographic}|\p{Regional_Indicator}|[#*0-9]\uFE0F?\u20E3)[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}\uFE0F\u200D\u20E3]*)(?:\s+|$)/u;

const squash = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '');
/** Muscle names as labels ("Front delts") or ids ("frontDelts"), in any case. */
const MUSCLE_BY_KEY = new Map(
  (Object.entries(MUSCLE_LABEL) as [MuscleGroup, string][]).flatMap(([id, label]) => [
    [squash(id), id] as const,
    [squash(label), id] as const,
  ]),
);

function parseExercise({ title, body }: Section): {
  exercise: TemplateExercise;
  sets: Omit<SetEntry, 'id'>[];
  note: string | undefined;
} {
  const emoji = EMOJI.exec(title)?.[1] ?? '';
  const name = title.slice(emoji ? EMOJI.exec(title)![0].length : 0).trim();

  const first = body.findIndex((l) => l.trim() !== '');
  const meta = new Map<string, string>();
  if (first >= 0 && META_LINE.test(body[first])) {
    for (const segment of body[first].split('·')) {
      const m = /^\s*(\w+)\s*:\s*(.*?)\s*$/.exec(segment);
      if (m) meta.set(m[1].toLowerCase().replace('colour', 'color'), m[2]);
    }
    body = body.slice(first + 1);
  }

  // Set lines anywhere in the block are sets; everything else is the note,
  // with the runs between sets kept as separate paragraphs.
  const sets: Omit<SetEntry, 'id'>[] = [];
  const runs: string[][] = [[]];
  for (const line of body) {
    const set = parseSet(line);
    if (set) {
      sets.push(set);
      runs.push([]);
    } else runs.at(-1)!.push(line);
  }
  const note = runs.map(trimBlankEdges).filter((r) => r.length > 0).map((r) => r.join('\n')).join('\n\n');

  const target = /^(\d+)\s*(?:[x×]\s*(.*))?$/i.exec(meta.get('target') ?? '');
  const muscles = (key: string) =>
    (meta.get(key) ?? '').split(',').flatMap((m) => MUSCLE_BY_KEY.get(squash(m)) ?? []);
  // No metadata line at all means a hand-written block: guess the muscles from the name.
  const guessed = meta.size === 0 ? lookupMuscles(name) : { primary: muscles('primary'), secondary: muscles('secondary') };
  const color = (meta.get('color') ?? '').toLowerCase();

  return {
    exercise: {
      name,
      emoji,
      color: COLORS.includes(color) ? (color as ExerciseColor) : 'blue',
      targetSets: target ? Number(target[1]) : sets.length,
      targetReps: target?.[2]?.trim() ?? '',
      primaryMuscles: guessed.primary,
      secondaryMuscles: guessed.secondary,
    },
    sets,
    note: note || undefined,
  };
}

/** `- [x] 185 lb × 5`, `- [ ] — × —`, `- [x] bw x 10`; anything else isn't a set. */
function parseSet(line: string): Omit<SetEntry, 'id'> | undefined {
  const m = SET_LINE.exec(line);
  if (!m) return undefined;
  const completed = m[1].toLowerCase() === 'x';
  if (m[2] === '') return { weight: null, reps: null, completed };
  const parts = /^(.*?)\s*[x×]\s*(.*)$/i.exec(m[2]);
  if (!parts) return undefined;
  const weight = amount(parts[1].replace(/\s*(lbs?|kgs?)$/i, ''), true);
  const reps = amount(parts[2], false);
  return weight === undefined || reps === undefined ? undefined : { weight, reps, completed };
}

function amount(text: string, weight: boolean): number | null | undefined {
  const t = text.trim();
  if (/^(|-|—|–)$/.test(t) || (weight && /^(bw|bodyweight)$/i.test(t))) return null;
  return /^-?\d+(?:[.,]\d+)?$/.test(t) ? Number(t.replace(',', '.')) : undefined;
}

// ---------------------------------------------------------------- markdown plumbing

interface Note {
  data: Record<string, unknown>;
  lines: string[];
}

/** Splits off YAML frontmatter. Broken YAML is read line by line rather than losing the file. */
function readNote(text: string, warn: (message: string) => void): Note {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  if (lines[0]?.trim() !== '---') return { data: {}, lines };
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (end < 0) return { data: {}, lines };

  const yaml = lines.slice(1, end);
  let data: Record<string, unknown>;
  try {
    const parsed: unknown = YAML.parse(yaml.join('\n'));
    data = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch (err) {
    warn(`frontmatter isn't valid YAML (${err instanceof Error ? err.message.split('\n')[0] : err}); reading it line by line.`);
    data = {};
    for (const line of yaml) {
      const m = /^(\w+)\s*:\s*(.*?)\s*$/.exec(line);
      if (m) data[m[1]] = m[2].replace(/^(["'])(.*)\1$/, '$2');
    }
  }
  return { data, lines: lines.slice(end + 1) };
}

const HEADING = /^(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;

interface Section {
  title: string;
  body: string[];
}

/**
 * Cuts lines into blocks at headings of exactly `level`. Deeper headings stay
 * in the block's body; a shallower one ends the block.
 */
function sections(lines: string[], level: number): { preamble: string[]; blocks: Section[] } {
  const preamble: string[] = [];
  const blocks: Section[] = [];
  let current: string[] | null = preamble;
  for (const line of lines) {
    const h = HEADING.exec(line);
    if (h && h[1].length === level) {
      blocks.push({ title: h[2] ?? '', body: [] });
      current = blocks.at(-1)!.body;
    } else if (h && h[1].length < level && blocks.length > 0) {
      current = null;
    } else {
      current?.push(line);
    }
  }
  return { preamble, blocks };
}

function heading1(lines: string[]): string {
  for (const line of lines) {
    const h = HEADING.exec(line);
    if (h?.[1] === '#') return (h[2] ?? '').trim();
  }
  return '';
}

function trimBlankEdges(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === '') start++;
  while (end > start && lines[end - 1].trim() === '') end--;
  return lines.slice(start, end);
}
