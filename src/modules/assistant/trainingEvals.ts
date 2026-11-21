import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNewPlan } from '../../../lib/defaults.js';
import { PlanStore } from '../training/store.js';
import { TrainingService } from '../training/service.js';
import { CASE_RUNNERS, type CaseRun, type Verdict } from './evals.js';
import { jobPrompt } from './factory.js';
import { runTools, toolMap, type Turn, type Usage } from './llm.js';
import { trainingTools } from './trainingTools.js';
import { addUsage } from './usage.js';

/**
 * Training-log evals. Each case is a chat message reporting sets. It runs
 * against a fresh training log in a temp folder (never the owner's), with the
 * real training tools and the prompt under test, on the chat model. Code then
 * reads back every set the log holds and compares it with what was expected.
 */

const MAX_STEPS = 10;

/** "Barbell bench press 185x5" or "… 185x5 @ 2026-11-19" for another day. */
const setKey = (exercise: string, weight: number, reps: number, date: string, today: string) =>
  `${exercise.toLowerCase()} ${weight}x${reps}${date === today ? '' : ` @ ${date}`}`;

/** Every completed set in the log, as setKeys, sorted. */
export function loggedSets(store: PlanStore, today: string): string[] {
  const plan = store.load();
  return Object.entries(plan.days)
    .flatMap(([date, day]) => day.exercises.flatMap((e) => e.sets.filter((s) => s.completed).map((s) => setKey(e.name, Number(s.weight), Number(s.reps), date, today))))
    .sort();
}

/** Sets logged: the log holds exactly the expected sets, no more, no fewer. An empty list means it should ask instead. */
export function setsVerdict(expected: string[], logged: string[], reply: string): Verdict {
  const want = expected.map((e) => e.toLowerCase().replace(/\s+/g, ' ').trim()).sort();
  if (!want.length) return logged.length ? { pass: false, why: `logged ${logged.join(', ')} instead of asking` } : { pass: true, why: `asked: ${reply.slice(0, 120)}` };
  const missing = want.filter((w, i) => want.indexOf(w) === i).flatMap((w) => Array(Math.max(0, want.filter((x) => x === w).length - logged.filter((x) => x === w).length)).fill(w));
  const extra = logged.filter((l, i) => logged.indexOf(l) === i).flatMap((l) => Array(Math.max(0, logged.filter((x) => x === l).length - want.filter((x) => x === l).length)).fill(l));
  if (!missing.length && !extra.length) return { pass: true, why: `${want.length} set(s), as expected` };
  return { pass: false, why: [missing.length ? `missing ${missing.join(', ')}` : '', extra.length ? `wrongly logged ${extra.join(', ')}` : ''].filter(Boolean).join('; ') };
}

const asList = (v: unknown) => (Array.isArray(v) ? v.map(String) : v ? [String(v)] : []);

CASE_RUNNERS['training-log'] = async (c, o, llm): Promise<CaseRun> => {
  const today = String(c.fields.today ?? '2026-11-20');
  const dir = mkdtempSync(join(tmpdir(), 'squire-training-eval-'));
  const store = new PlanStore(dir);
  try {
    store.init(createNewPlan('Eval log', 'lb', today));
    const training = new TrainingService(store, () => new Date(`${today}T12:00:00`));
    // What was already loaded before the message: "Push day" for today, or "Legs day @ 2026-11-19".
    for (const l of asList(c.fields.loaded)) {
      const [split, date] = l.split('@').map((x) => x.trim());
      training.loadSplit(split!, date || today);
    }
    const handlers = trainingTools(training);
    const system = `You are Squire, the owner's assistant on Discord. Today is ${today}, owner's time zone ${o.timeZone}.\n${jobPrompt(o.vault, 'training-log', o.prompt).text.trim()}`;
    const turns: Turn[] = [{ role: 'user', content: [{ type: 'text', text: c.input }] }];
    let reply = '';
    let usage: Usage | undefined;
    const trace: string[] = [];
    for (let step = 0; step < MAX_STEPS; step++) {
      const gen = await llm.generate({ model: o.judge.model, effort: 'low' }, { system, tools: handlers.map((h) => h.def), turns, web: { maxUses: 0 } });
      if (gen.usage) usage = usage ? addUsage(usage, gen.usage) : gen.usage;
      reply = gen.text;
      if (!gen.calls.length) break;
      turns.push(gen.turn);
      const results = await runTools(gen.calls, toolMap(handlers));
      for (const [i, r] of results.entries()) trace.push(`${gen.calls[i]!.name} ${JSON.stringify(gen.calls[i]!.input)} -> ${r.isError ? 'error: ' : ''}${r.content.split('\n')[0]}`);
      turns.push({ role: 'tool', results });
    }
    const logged = loggedSets(store, today);
    const verdicts: Record<string, Verdict> = { 'Sets logged': setsVerdict(asList(c.fields.expect_sets), logged, reply) };
    const split = String(c.fields.expect_split ?? '');
    if (split) {
      const loaded = store.load().days[today]?.exercises.length ? trace.some((t) => t.startsWith('training_load_split') && t.toLowerCase().includes(split.toLowerCase()) && !t.includes('-> error')) : false;
      verdicts['Right split loaded'] = loaded ? { pass: true, why: split } : { pass: false, why: `didn't load ${split}` };
    }
    const note = `Logged:\n${logged.map((l) => `- ${l}`).join('\n') || '- nothing'}\n\nCalls:\n${trace.map((t) => `- ${t}`).join('\n') || '- none'}`;
    return { output: 'training log (temp copy)', note, report: reply, status: 'done', evidence: c.input, usage, verdicts };
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
};

type Seed = { name: string; fields: Record<string, unknown>; why: string };

/**
 * Starter cases: the ways sets get reported in chat, each aimed at a line of
 * the prompt (one call per set, load the split first, another day, bodyweight,
 * ask when it isn't clear). Exercise names are the built-in splits'.
 */
export const TRAINING_CASES: Seed[] = [
  { name: 'Three bench sets', why: '"bench 185x5, 185x5, 175x6" is three calls, at the weights given, on the session\'s own exercise name.', fields: { today: '2026-11-20', loaded: ['Push day'], input: 'bench 185x5, 185x5, 175x6', expect_sets: ['Barbell bench press 185x5', 'Barbell bench press 185x5', 'Barbell bench press 175x6'] } },
  { name: 'Sets by reps notation', why: '"squat 3x5 at 225" means three sets of five, not one set of three.', fields: { today: '2026-11-20', loaded: ['Legs day'], input: 'squat 3x5 at 225', expect_sets: ['Back squat 225x5', 'Back squat 225x5', 'Back squat 225x5'] } },
  { name: 'Nothing loaded yet', why: '"If today has nothing loaded, load the right split first."', fields: { today: '2026-11-20', input: 'push day done: bench 155x6 x2, ohp 95x8', expect_split: 'Push day', expect_sets: ['Barbell bench press 155x6', 'Barbell bench press 155x6', 'Overhead press 95x8'] } },
  { name: 'Yesterday', why: 'Sets for another day go on that day, not today.', fields: { today: '2026-11-20', loaded: ['Legs day @ 2026-11-19'], input: 'forgot to log yesterday: rdl 185 for 8, 8 and 7', expect_sets: ['Romanian deadlift 185x8 @ 2026-11-19', 'Romanian deadlift 185x8 @ 2026-11-19', 'Romanian deadlift 185x7 @ 2026-11-19'] } },
  { name: 'Bodyweight pull-ups', why: 'Bodyweight sets are weight 0.', fields: { today: '2026-11-20', loaded: ['Pull day'], input: 'pullups 10, 8, 7', expect_sets: ['Pull-up / lat pulldown 0x10', 'Pull-up / lat pulldown 0x8', 'Pull-up / lat pulldown 0x7'] } },
  { name: 'No exercise named', why: 'A set with no exercise can\'t be logged; ask which one rather than guess.', fields: { today: '2026-11-20', loaded: ['Push day'], input: 'did 3 sets at 135', expect_sets: [] } },
];
