import type { DayLog, PlanData } from './types';
import { MUSCLE_LABEL } from './muscles';
import {
  computeMuscleVolume,
  computeProgression,
  computeTrainingStats,
  summarizeProgression,
} from './scoring';
import type { LiftProgress } from './scoring';
import { formatDayHeading, weekRangeLabel } from './dateUtils';

const HOST_STORAGE = 'squire-ollama-host';
const MODEL_STORAGE = 'squire-summary-model';

/** What each key was called before the app was renamed to Squire. */
const LEGACY_STORAGE: Record<string, string> = {
  [HOST_STORAGE]: 'structured-ollama-host',
  [MODEL_STORAGE]: 'structured-summary-model',
};

/**
 * Renaming the keys outright would quietly reset anyone already using the app:
 * a custom Ollama host would revert to the default and the chosen model would
 * be forgotten, with nothing on screen to say a setting had been lost. So a
 * value left under the old key is moved across on first read and the old key
 * dropped. Lazily, inside the accessors, because the Discord bot imports this
 * file under Node, where there is no localStorage to touch at module load.
 */
function readSetting(key: string): string | null {
  const current = localStorage.getItem(key);
  if (current !== null) return current;

  const legacy = localStorage.getItem(LEGACY_STORAGE[key]);
  if (legacy === null) return null;

  localStorage.setItem(key, legacy);
  localStorage.removeItem(LEGACY_STORAGE[key]);
  return legacy;
}

/** Clears the old key too, so a cleared setting cannot be resurrected by it. */
function writeSetting(key: string, value: string): void {
  localStorage.removeItem(LEGACY_STORAGE[key]);
  if (value) localStorage.setItem(key, value);
  else localStorage.removeItem(key);
}

export const DEFAULT_HOST = 'http://localhost:11434';

/**
 * qwen2.5:7b is the recommendation: measured against llama3.2 on the same week,
 * it cited muscle set counts and target ranges correctly where llama3.2
 * repeatedly misattributed both, at no speed cost once the model is resident.
 */
export const SUGGESTED_MODELS = ['qwen2.5:7b', 'llama3.2', 'gemma3:4b', 'mistral'];

export function getHost(): string {
  return readSetting(HOST_STORAGE) ?? DEFAULT_HOST;
}

export function setHost(host: string): void {
  writeSetting(HOST_STORAGE, host.trim().replace(/\/+$/, ''));
}

export function getModel(): string | null {
  return readSetting(MODEL_STORAGE);
}

export function setModel(model: string): void {
  writeSetting(MODEL_STORAGE, model);
}

export class OllamaUnreachableError extends Error {
  constructor(host: string) {
    super(
      `Couldn't reach Ollama at ${host}. Make sure it's installed and running — "ollama serve" starts it.`,
    );
  }
}

/** Installed models, which doubles as the connectivity check. */
export async function listModels(host: string): Promise<string[]> {
  let response: Response;
  try {
    response = await fetch(`${host}/api/tags`);
  } catch {
    throw new OllamaUnreachableError(host);
  }
  if (!response.ok) throw new Error(`Ollama returned ${response.status} listing models.`);
  const data = (await response.json()) as { models?: { name?: string }[] };
  return (data.models ?? []).map((m) => m.name).filter((n): n is string => Boolean(n));
}

export interface WeekSummary {
  headline: string;
  effort: string;
  improvement: string;
  focus: string;
}

/**
 * The progression line is rendered from the computed figures rather than asked
 * of the model. Small local models reliably mangle it — llama3.2 reported a
 * +10.8% squat PR as "held" in three runs out of three, once while quoting both
 * numbers that contradicted it. The app already knows these facts exactly, so
 * paraphrasing them through a model is all risk and no benefit. The model is
 * left the parts that actually need judgement.
 */
export function renderProgression(lifts: LiftProgress[], unit: string): string {
  if (lifts.length === 0) return 'No completed sets with both weight and reps recorded this week.';

  const phrase = (l: LiftProgress) => {
    const best = Math.round(l.best);
    if (l.verdict === 'new') return `${l.name} logged at ${best} ${unit} e1RM, with no earlier session to compare`;
    const prev = Math.round(l.previousBest!);
    const pct = Math.abs(l.deltaPercent!).toFixed(1);
    if (l.verdict === 'pr') return `${l.name} rose ${pct}% to ${best} ${unit} e1RM, past its previous best of ${prev}`;
    if (l.verdict === 'down') return `${l.name} fell ${pct}% to ${best} ${unit} e1RM, under its previous best of ${prev}`;
    return `${l.name} held at ${best} ${unit} e1RM`;
  };

  const order: LiftProgress['verdict'][] = ['pr', 'down', 'matched', 'new'];
  return order
    .flatMap((v) => lifts.filter((l) => l.verdict === v))
    .map((l) => `${phrase(l)}.`)
    .join(' ');
}

/**
 * Condenses the week into the smallest factual payload that still supports a
 * grounded summary — days trained, muscle coverage against target, and the
 * per-lift e1RM movement. Deliberately pre-computed rather than handing over
 * raw sets, so the model reports the numbers instead of deriving them. This
 * is what makes a small local model sufficient for the job.
 */
export function buildWeekFacts(plan: PlanData, weekDays: DayLog[], selectedDate: string): string {
  const stats = computeTrainingStats(weekDays);
  const volumes = computeMuscleVolume(weekDays);
  const lifts = computeProgression(plan.days, weekDays);
  const progression = summarizeProgression(lifts);
  const unit = plan.config.unit;

  const sessions = weekDays
    .filter((d) => d.exercises.length > 0)
    .map((d) => {
      const s = computeTrainingStats([d]);
      const template = plan.templates.find((t) => t.id === d.templateId)?.name ?? 'Custom session';
      return `- ${formatDayHeading(d.date)}: ${template}, ${s.completedSetCount}/${s.plannedSetCount} sets completed across ${s.exerciseCount} exercises`;
    });

  const trained = volumes.filter((v) => v.sets > 0);
  const muscleLines = trained.map(
    (v) =>
      `- ${MUSCLE_LABEL[v.muscle]}: ${v.sets} hard sets (target ${v.target.min}-${v.target.max}) — ${v.state}`,
  );
  const untrained = volumes.filter((v) => v.sets === 0).map((v) => MUSCLE_LABEL[v.muscle]);

  const liftLines = lifts.map((l) => {
    if (l.verdict === 'new') return `- ${l.name}: ${Math.round(l.best)} ${unit} e1RM (no prior record)`;
    const dir = l.deltaPercent! >= 0 ? '+' : '';
    return `- ${l.name}: ${Math.round(l.best)} ${unit} e1RM vs previous best ${Math.round(
      l.previousBest!,
    )} (${dir}${l.deltaPercent!.toFixed(1)}%) — ${l.verdict}`;
  });

  return [
    `Week of ${weekRangeLabel(selectedDate)}. Weight unit: ${unit}.`,
    ``,
    `SESSIONS (${stats.daysTrained} days trained):`,
    sessions.length ? sessions.join('\n') : '- No sessions logged.',
    ``,
    `TOTALS: ${stats.completedSetCount} of ${stats.plannedSetCount} planned sets completed; ${stats.totalReps} reps.`,
    ``,
    `MUSCLE COVERAGE — ${trained.filter((v) => v.state === 'under').length} under target, ${
      trained.filter((v) => v.state === 'in-range').length
    } in range, ${trained.filter((v) => v.state === 'over').length} over, ${untrained.length} untrained.`,
    `(a set counts 1 for a primary muscle, 0.5 for an assisting one)`,
    muscleLines.length ? muscleLines.join('\n') : '- Nothing trained.',
    untrained.length ? `- Not trained at all this week: ${untrained.join(', ')}` : '',
    ``,
    `LOAD PROGRESSION (estimated 1RM vs the best from any earlier session):`,
    liftLines.length ? liftLines.join('\n') : '- No completed sets with weight and reps recorded.',
    ``,
    `PROGRESSION TALLY: ${progression.prs} lifts up, ${progression.matched} held, ${progression.down} down, ${progression.fresh} with no history.`,
  ]
    .filter((line) => line !== '')
    .join('\n');
}

const SYSTEM_PROMPT = `You are reviewing one week of a lifter's training log and writing a short report.

Write to the lifter as "you", plainly and without hype. Every number you cite must be copied from the data given to you — never estimate, round differently, or invent a figure. Be honest about a bad week: if volume was under target or lifts went backwards, say so directly rather than softening it into praise.

Reply with JSON only. No headers, no bullet lists, no emoji.`;

/**
 * Small local models do not reliably read length or content requirements out of
 * JSON-schema `description` fields — llama3.2 answers a schema-only prompt with
 * one-word stubs. Stating the requirements inline, with a worked example of the
 * expected density, is what actually gets full sentences out of a 3B model.
 */
const OUTPUT_SPEC = `Write three fields. Each must be complete sentences packed with the actual numbers above.

- "headline": one sentence under 15 words characterising the week overall. Use no digits or figures at all — every number belongs in the fields below, where there is room to state it correctly.
- "effort": 2-3 full sentences addressed to the lifter as "you". Open with days trained and sets completed out of planned. Then pick out the two or three most notable muscle groups only — the biggest shortfalls or anything over its ceiling — and give each one's set count against its target. Do not list every muscle group; the full breakdown is already on screen beside this text, so naming them all adds nothing.
- "focus": 1-2 sentences naming the single most useful change for next week, pointing at a specific gap in the data above.

Write in full prose sentences, not fragments or single words. Every muscle name, set count, and percentage must come from the data above.`;

/**
 * Per-model corrections, appended to the spec. Each addresses a failure mode
 * observed from that specific model on real runs rather than a guess:
 * llama3.2 pairs a muscle with a different muscle's set count and target range;
 * qwen2.5 misreads the trailing state label and reports an under-target group
 * as having met its target.
 */
const MODEL_NOTES: Record<string, string> = {
  'llama3.2': `Accuracy check before you answer. Each MUSCLE COVERAGE line owns three things: its name, its set count, and its target range. Never carry a number across lines — if you mention front delts, its count and its target must be read from the front delts line, not from chest or any other. Re-read the line you are quoting before you write each figure. Sets and reps are also different units: the sets figure is in TOTALS as "X of Y planned sets", and the reps figure is a separate number. Never state one as the other.`,
  'qwen2.5': `Accuracy check before you answer. Every MUSCLE COVERAGE line ends with a state word after a dash: "under", "in-range", or "over". That word is the verdict — trust it over your own reading of the numbers. A line ending in "under" has NOT met its target, however close the count looks, so never describe it as hitting, meeting, or reaching its mark. Address the lifter as "you" throughout.`,
};

function specFor(model: string): string {
  const key = Object.keys(MODEL_NOTES).find((k) => model.toLowerCase().startsWith(k));
  const note = key ? `\n\n${MODEL_NOTES[key]}` : '';
  return `${OUTPUT_SPEC}${note}\n\nNow write the three fields for the data above.`;
}

const SCHEMA = {
  type: 'object',
  properties: {
    headline: {
      type: 'string',
      description: 'One sentence, under 15 words, characterising the week overall.',
    },
    effort: {
      type: 'string',
      description:
        'Two or three sentences on the objective work done: days trained, sets completed against planned, and which muscle groups landed in, under, or over their target range. Cite the actual numbers.',
    },
    focus: {
      type: 'string',
      description:
        'One or two sentences naming the single most useful thing to change next week, grounded in a specific gap in the data.',
    },
  },
  required: ['headline', 'effort', 'focus'],
};

/** Small models sometimes wrap JSON in markdown fences despite the schema. */
type ModelFields = Omit<WeekSummary, 'improvement'>;

function parseSummary(raw: string, model: string): ModelFields {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error('The model did not return valid JSON. Try a different model.');
  }
  const s = parsed as Partial<WeekSummary>;
  if (!s.headline || !s.effort || !s.focus) {
    throw new Error('The model left parts of the summary empty. Try a different model.');
  }

  // A schema-valid response can still be useless: small models sometimes fill
  // every field with a single word. Fail loudly rather than rendering a summary
  // that looks like a report but says nothing.
  if (s.effort.trim().length < 60) {
    throw new Error(
      `${model} answered with a one-line stub instead of full sentences. A larger model handles this better — try qwen2.5:7b.`,
    );
  }

  return s as ModelFields;
}

export interface WeekInput {
  /** Everything the model is shown. */
  facts: string;
  /** Rendered in code, not asked of the model. */
  improvement: string;
}

export function buildWeekInput(plan: PlanData, weekDays: DayLog[], selectedDate: string): WeekInput {
  return {
    facts: buildWeekFacts(plan, weekDays, selectedDate),
    improvement: renderProgression(computeProgression(plan.days, weekDays), plan.config.unit),
  };
}

export async function generateWeekSummary(
  input: WeekInput,
  host: string,
  model: string,
): Promise<WeekSummary> {
  const facts = input.facts;
  let response: Response;
  try {
    response = await fetch(`${host}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        // Ollama constrains decoding to this schema, so the shape is reliable
        // even from a small model.
        format: SCHEMA,
        options: { temperature: 0.3 },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `${facts}\n\n---\n\n${specFor(model)}` },
        ],
      }),
    });
  } catch {
    throw new OllamaUnreachableError(host);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    if (response.status === 404) {
      throw new Error(`Ollama doesn't have "${model}" pulled. Run: ollama pull ${model}`);
    }
    throw new Error(`Ollama returned ${response.status}. ${body.slice(0, 200)}`);
  }

  const data = (await response.json()) as { message?: { content?: string } };
  const content = data.message?.content;
  if (!content) throw new Error('Ollama returned an empty response.');
  return { ...parseSummary(content, model), improvement: input.improvement };
}
