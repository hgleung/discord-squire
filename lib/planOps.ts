import { v4 as uuid } from 'uuid';
import type {
  DayLog,
  Exercise,
  PlanData,
  QuickAddExercise,
  SetEntry,
  TemplateExercise,
  WorkoutTemplate,
} from './types';
import { getWeekDates, toISODate } from './dateUtils';

export function getOrEmptyDay(plan: PlanData, dateISO: string): DayLog {
  return plan.days[dateISO] ?? { date: dateISO, exercises: [] };
}

export function getWeekDays(plan: PlanData, anchorISO: string): DayLog[] {
  return getWeekDates(anchorISO).map((d) => getOrEmptyDay(plan, toISODate(d)));
}

export function blankSet(): SetEntry {
  return { id: uuid(), weight: null, reps: null, completed: false };
}

/**
 * Seeds an exercise with its target number of empty sets, carrying forward the
 * weight and reps last used for the same exercise so repeat sessions start
 * from where the previous one left off.
 */
export function exerciseFromTemplate(te: TemplateExercise, seed?: SetEntry): Exercise {
  return {
    id: uuid(),
    name: te.name,
    emoji: te.emoji,
    color: te.color,
    targetSets: te.targetSets,
    targetReps: te.targetReps,
    primaryMuscles: te.primaryMuscles ?? [],
    secondaryMuscles: te.secondaryMuscles ?? [],
    sets: Array.from({ length: Math.max(1, te.targetSets) }, () => ({
      ...blankSet(),
      weight: seed?.weight ?? null,
      reps: seed?.reps ?? null,
    })),
  };
}

/** Most recent completed set for an exercise name, searching backwards in time. */
export function lastPerformedSet(plan: PlanData, name: string, beforeISO: string): SetEntry | undefined {
  const dates = Object.keys(plan.days)
    .filter((d) => d < beforeISO)
    .sort()
    .reverse();
  for (const date of dates) {
    const match = plan.days[date].exercises.find(
      (e) => e.name.toLowerCase() === name.toLowerCase(),
    );
    const done = match?.sets.filter((s) => s.completed) ?? [];
    if (done.length > 0) return done[done.length - 1];
  }
  return undefined;
}

function writeDay(plan: PlanData, dateISO: string, day: DayLog): PlanData {
  return { ...plan, days: { ...plan.days, [dateISO]: day } };
}

export function upsertExercise(plan: PlanData, dateISO: string, exercise: Exercise): PlanData {
  const day = getOrEmptyDay(plan, dateISO);
  const exists = day.exercises.some((e) => e.id === exercise.id);
  const exercises = exists
    ? day.exercises.map((e) => (e.id === exercise.id ? exercise : e))
    : [...day.exercises, exercise];
  return writeDay(plan, dateISO, { ...day, exercises });
}

export function deleteExercise(plan: PlanData, dateISO: string, exerciseId: string): PlanData {
  const day = getOrEmptyDay(plan, dateISO);
  return writeDay(plan, dateISO, {
    ...day,
    exercises: day.exercises.filter((e) => e.id !== exerciseId),
  });
}

export function moveExercise(plan: PlanData, dateISO: string, exerciseId: string, delta: number): PlanData {
  const day = getOrEmptyDay(plan, dateISO);
  const idx = day.exercises.findIndex((e) => e.id === exerciseId);
  const target = idx + delta;
  if (idx < 0 || target < 0 || target >= day.exercises.length) return plan;
  const exercises = [...day.exercises];
  [exercises[idx], exercises[target]] = [exercises[target], exercises[idx]];
  return writeDay(plan, dateISO, { ...day, exercises });
}

function mapExercise(
  plan: PlanData,
  dateISO: string,
  exerciseId: string,
  fn: (e: Exercise) => Exercise,
): PlanData {
  const day = getOrEmptyDay(plan, dateISO);
  return writeDay(plan, dateISO, {
    ...day,
    exercises: day.exercises.map((e) => (e.id === exerciseId ? fn(e) : e)),
  });
}

export function updateSet(
  plan: PlanData,
  dateISO: string,
  exerciseId: string,
  setId: string,
  patch: Partial<SetEntry>,
): PlanData {
  return mapExercise(plan, dateISO, exerciseId, (e) => ({
    ...e,
    sets: e.sets.map((s) => (s.id === setId ? { ...s, ...patch } : s)),
  }));
}

export function addSet(plan: PlanData, dateISO: string, exerciseId: string): PlanData {
  return mapExercise(plan, dateISO, exerciseId, (e) => {
    const last = e.sets[e.sets.length - 1];
    return {
      ...e,
      sets: [...e.sets, { ...blankSet(), weight: last?.weight ?? null, reps: last?.reps ?? null }],
    };
  });
}

export function removeSet(plan: PlanData, dateISO: string, exerciseId: string, setId: string): PlanData {
  return mapExercise(plan, dateISO, exerciseId, (e) => ({
    ...e,
    sets: e.sets.filter((s) => s.id !== setId),
  }));
}

export function applyTemplateToDay(plan: PlanData, dateISO: string, templateId: string): PlanData {
  const template = plan.templates.find((t) => t.id === templateId);
  if (!template) return plan;
  const exercises = template.exercises.map((te) =>
    exerciseFromTemplate(te, lastPerformedSet(plan, te.name, dateISO)),
  );
  return writeDay(plan, dateISO, { date: dateISO, exercises, templateId });
}

export function applyTemplateToRange(plan: PlanData, dateISOs: string[], templateId: string): PlanData {
  return dateISOs.reduce((acc, dateISO) => applyTemplateToDay(acc, dateISO, templateId), plan);
}

export function addQuickAddToDay(plan: PlanData, dateISO: string, item: QuickAddExercise): PlanData {
  return upsertExercise(
    plan,
    dateISO,
    exerciseFromTemplate(item, lastPerformedSet(plan, item.name, dateISO)),
  );
}

export function upsertTemplate(plan: PlanData, template: WorkoutTemplate): PlanData {
  const exists = plan.templates.some((t) => t.id === template.id);
  const templates = exists
    ? plan.templates.map((t) => (t.id === template.id ? template : t))
    : [...plan.templates, template];
  return { ...plan, templates };
}

export function deleteTemplate(plan: PlanData, templateId: string): PlanData {
  return { ...plan, templates: plan.templates.filter((t) => t.id !== templateId) };
}

export function newBlankExercise(): Exercise {
  return {
    id: uuid(),
    name: '',
    emoji: '🏋️',
    color: 'blue',
    targetSets: 3,
    targetReps: '10',
    primaryMuscles: [],
    secondaryMuscles: [],
    sets: [blankSet(), blankSet(), blankSet()],
  };
}
