import type { PlanData, QuickAddExercise, TemplateExercise, WorkoutTemplate } from './types';
import { CURRENT_VERSION } from './types';
import { lookupMuscles } from './muscles';

const ex = (
  name: string,
  emoji: string,
  color: TemplateExercise['color'],
  targetSets: number,
  targetReps: string,
): TemplateExercise => {
  const { primary, secondary } = lookupMuscles(name);
  return { name, emoji, color, targetSets, targetReps, primaryMuscles: primary, secondaryMuscles: secondary };
};

export const BUILTIN_TEMPLATES: WorkoutTemplate[] = [
  {
    id: 'tpl-push-day',
    name: 'Push day',
    description: 'Chest, shoulders, triceps.',
    isBuiltin: true,
    exercises: [
      ex('Barbell bench press', '🏋️', 'red', 4, '6'),
      ex('Overhead press', '🏋️', 'red', 3, '8'),
      ex('Incline dumbbell press', '💪', 'orange', 3, '10'),
      ex('Lateral raise', '💪', 'orange', 3, '12-15'),
      ex('Triceps pushdown', '💪', 'orange', 3, '12'),
      ex('Overhead triceps extension', '💪', 'yellow', 3, '12'),
    ],
  },
  {
    id: 'tpl-pull-day',
    name: 'Pull day',
    description: 'Back, rear delts, biceps.',
    isBuiltin: true,
    exercises: [
      ex('Deadlift', '🏋️', 'blue', 3, '5'),
      ex('Pull-up / lat pulldown', '🏋️', 'blue', 4, '8'),
      ex('Barbell row', '💪', 'teal', 3, '8'),
      ex('Seated cable row', '💪', 'teal', 3, '10'),
      ex('Face pull', '💪', 'teal', 3, '15'),
      ex('Barbell curl', '💪', 'yellow', 3, '10'),
    ],
  },
  {
    id: 'tpl-legs-day',
    name: 'Legs day',
    description: 'Quads, hamstrings, glutes, calves.',
    isBuiltin: true,
    exercises: [
      ex('Back squat', '🦵', 'purple', 4, '6'),
      ex('Romanian deadlift', '🦵', 'purple', 3, '8'),
      ex('Leg press', '🦵', 'pink', 3, '10'),
      ex('Leg curl', '🦵', 'pink', 3, '12'),
      ex('Leg extension', '🦵', 'pink', 3, '12'),
      ex('Standing calf raise', '🦵', 'yellow', 4, '15'),
    ],
  },
  {
    id: 'tpl-upper-accessory',
    name: 'Upper accessory',
    description: 'Lighter pump day — arms, delts, core.',
    isBuiltin: true,
    exercises: [
      ex('Incline dumbbell press', '💪', 'orange', 3, '12'),
      ex('Cable row', '💪', 'teal', 3, '12'),
      ex('Lateral raise', '💪', 'orange', 4, '15'),
      ex('Dumbbell curl', '💪', 'yellow', 3, '12'),
      ex('Rope pushdown', '💪', 'yellow', 3, '12'),
      ex('Hanging leg raise', '🧱', 'green', 3, '12'),
    ],
  },
  {
    id: 'tpl-full-body',
    name: 'Full body',
    description: 'One compound per pattern — good for a short week.',
    isBuiltin: true,
    exercises: [
      ex('Back squat', '🦵', 'purple', 3, '5'),
      ex('Barbell bench press', '🏋️', 'red', 3, '5'),
      ex('Barbell row', '💪', 'teal', 3, '8'),
      ex('Overhead press', '🏋️', 'red', 3, '8'),
      ex('Plank', '🧱', 'green', 3, '60s'),
    ],
  },
  {
    id: 'tpl-conditioning',
    name: 'Conditioning',
    description: 'Zone 2 and core — no heavy loading.',
    isBuiltin: true,
    exercises: [
      ex('Incline walk', '🚶', 'green', 1, '30-40 min'),
      ex('Core circuit', '🧱', 'green', 3, '3 rounds'),
      ex('Full-body mobility', '🧘', 'green', 1, '15 min'),
    ],
  },
];

export const DEFAULT_QUICK_ADD_EXERCISES: QuickAddExercise[] = [
  { id: 'qa-core', ...ex('Core circuit', '🧱', 'green', 3, '3 rounds') },
  { id: 'qa-cardio', ...ex('Incline walk / cardio', '🚶', 'green', 1, '20 min') },
  { id: 'qa-stretch', ...ex('Stretch / mobility', '🧘', 'green', 1, '15 min') },
  { id: 'qa-curls', ...ex('Dumbbell curl', '💪', 'yellow', 3, '12') },
];

export function createNewPlan(planName: string, unit: PlanData['config']['unit'], createdDate: string): PlanData {
  return {
    version: CURRENT_VERSION,
    config: { planName, unit, createdDate },
    days: {},
    templates: BUILTIN_TEMPLATES.map((t) => ({ ...t })),
    quickAddExercises: DEFAULT_QUICK_ADD_EXERCISES.map((q) => ({ ...q })),
  };
}
