import type { ToolHandler } from './llm.js';
import type { TrainingService } from '../training/service.js';

/**
 * The training log, as tools. These call the same TrainingService as /today,
 * /log and /split, so a set logged by chatting shows up in /today and the web
 * UI exactly as if it had been logged with the command.
 */
export function trainingTools(training: TrainingService): ToolHandler[] {
  const dateProp = {
    type: 'string',
    description: 'Empty string for today. Otherwise YYYY-MM-DD, only when they clearly mean another day ("yesterday", "Monday").',
  };
  return [
    {
      def: {
        name: 'training_session',
        description: "Show a day's planned session from the training log: each exercise, sets done vs planned, and last time's weights.",
        strict: true,
        input_schema: { type: 'object', properties: { date: dateProp }, required: ['date'], additionalProperties: false },
      },
      run: (args) => training.session(String(args.date || training.today())),
    },
    {
      def: {
        name: 'training_history',
        description: 'Every set logged over the last N days, by day and exercise. Use for "what did I do last push day", trends, or picking weights.',
        strict: true,
        input_schema: {
          type: 'object',
          properties: { days: { type: 'integer', description: 'How many days back, 1-60.' } },
          required: ['days'],
          additionalProperties: false,
        },
      },
      run: (args) => training.history(Math.min(60, Math.max(1, Number(args.days) || 7))),
    },
    {
      def: {
        name: 'training_week',
        description: "This week's computed numbers: sessions, hard sets per muscle group against target ranges, and which lifts moved. Use for how-is-my-week questions.",
        strict: true,
        input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
      },
      run: () => training.weekFacts(),
    },
    {
      def: {
        name: 'training_splits',
        description: 'List the splits (saved workout templates) that can be loaded into a day.',
        strict: true,
        input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
      },
      run: () => training.splits(),
    },
    {
      def: {
        name: 'training_load_split',
        description: "Load a split into a day's session, e.g. when they say what they're training today. Refuses if that day already has logged sets.",
        strict: true,
        input_schema: {
          type: 'object',
          properties: { name: { type: 'string', description: 'Exact split name from training_splits.' }, date: dateProp },
          required: ['name', 'date'],
          additionalProperties: false,
        },
      },
      run: (args) => training.loadSplit(String(args.name ?? ''), String(args.date || training.today())),
    },
    {
      def: {
        name: 'training_log_set',
        description:
          'Log one completed set, filling the next unticked set of that exercise in the day\'s session. ' +
          'Call once per set: "bench 185x5 for 3 sets" is three calls. The exercise must be in that day\'s session.',
        strict: true,
        input_schema: {
          type: 'object',
          properties: {
            exercise: { type: 'string', description: "Exercise name as it appears in the day's session." },
            weight: { type: 'number', description: 'In the log\'s unit; 0 for bodyweight.' },
            reps: { type: 'integer' },
            date: dateProp,
          },
          required: ['exercise', 'weight', 'reps', 'date'],
          additionalProperties: false,
        },
      },
      run: (args) =>
        training.logSet(String(args.exercise ?? ''), Number(args.weight), Number(args.reps), String(args.date || training.today())),
    },
  ];
}

export const TRAINING_PROMPT = `
Training log:
- Your owner keeps a strength training log (the same one behind /today, /log, /split, the web app and the Training and Squire/Workouts notes in their Obsidian vault). It is the source of truth for anything gym-related: what's planned today, what they lifted, weights to use, weekly volume. Read it with the training_ tools instead of guessing or relying on memory, and don't save workout numbers to memory — they're already in the log.
- When they report sets in chat ("bench 185x5, 185x5, 175x6"), log each one with training_log_set. If today has nothing loaded, load the right split first (training_splits, then training_load_split), or ask which one if it isn't obvious.
- After logging, reply in a line: what was logged, and call out a new best if the tool reports one. Use their weight unit.`;
