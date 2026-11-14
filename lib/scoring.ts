import type { DayLog, Exercise, SetEntry } from './types';
import type { MuscleGroup } from './muscles';
import { MUSCLE_ORDER, MUSCLE_TARGETS, SECONDARY_SET_WEIGHT } from './muscles';

/**
 * Estimated one-rep max (Epley). Lets a heavy triple and a lighter set of ten
 * be compared on the same scale, which is what makes load progression legible.
 */
export function estimated1RM(set: SetEntry): number | null {
  if (!set.completed || set.weight === null || set.reps === null) return null;
  if (set.weight <= 0 || set.reps <= 0) return null;
  return set.weight * (1 + set.reps / 30);
}

export function bestE1RM(exercise: Exercise): number | null {
  const values = exercise.sets.map(estimated1RM).filter((v): v is number => v !== null);
  return values.length > 0 ? Math.max(...values) : null;
}

export interface MuscleVolume {
  muscle: MuscleGroup;
  sets: number;
  target: { min: number; max: number };
  /** 'under' below min, 'in-range' between, 'over' past max, 'untrained' at zero. */
  state: 'untrained' | 'under' | 'in-range' | 'over';
}

/** Weekly hard sets per muscle: a completed set counts 1 for primary, ½ for secondary. */
export function computeMuscleVolume(days: DayLog[]): MuscleVolume[] {
  const totals = new Map<MuscleGroup, number>();

  for (const day of days) {
    for (const exercise of day.exercises) {
      const done = exercise.sets.filter((s) => s.completed).length;
      if (done === 0) continue;
      for (const m of exercise.primaryMuscles ?? []) {
        totals.set(m, (totals.get(m) ?? 0) + done);
      }
      for (const m of exercise.secondaryMuscles ?? []) {
        totals.set(m, (totals.get(m) ?? 0) + done * SECONDARY_SET_WEIGHT);
      }
    }
  }

  return MUSCLE_ORDER.map((muscle) => {
    const sets = Math.round((totals.get(muscle) ?? 0) * 10) / 10;
    const target = MUSCLE_TARGETS[muscle];
    let state: MuscleVolume['state'] = 'untrained';
    if (sets > 0) state = sets < target.min ? 'under' : sets > target.max ? 'over' : 'in-range';
    return { muscle, sets, target, state };
  });
}

/**
 * The headline number: of the muscles you actually trained this week, how many
 * landed inside their productive volume range. Muscles you never touched are
 * excluded rather than counted as failures, so a push-only week isn't graded
 * against your legs.
 */
export function volumeRating(volumes: MuscleVolume[]): number | null {
  const trained = volumes.filter((v) => v.sets > 0);
  if (trained.length === 0) return null;
  const scored = trained.reduce((sum, v) => {
    if (v.state === 'in-range') return sum + 1;
    if (v.state === 'over') return sum + 0.75; // productive, just past the recovery ceiling
    return sum + Math.min(1, v.sets / v.target.min) * 0.8; // partial credit toward the minimum
  }, 0);
  return Math.round((scored / trained.length) * 5 * 10) / 10;
}

export function volumeRatingLabel(rating: number | null): string {
  if (rating === null) return 'Nothing logged yet';
  if (rating >= 4.5) return 'Volume dialled in';
  if (rating >= 3.5) return 'Mostly on target';
  if (rating >= 2.5) return 'Some gaps';
  if (rating >= 1.5) return 'Under-volumed';
  return 'Just getting started';
}

export function completedSets(exercise: Exercise): number {
  return exercise.sets.filter((s) => s.completed).length;
}

/** Planned sets = whatever is on the card, or the target if none have been added yet. */
export function plannedSets(exercise: Exercise): number {
  return Math.max(exercise.sets.length, exercise.targetSets);
}

export function isExerciseComplete(exercise: Exercise): boolean {
  const planned = plannedSets(exercise);
  return planned > 0 && completedSets(exercise) >= planned;
}

export interface TrainingStats {
  exerciseCount: number;
  completedExercises: number;
  plannedSetCount: number;
  completedSetCount: number;
  totalReps: number;
  /** Percentage of planned sets actually completed, or null when nothing is planned. */
  completionPercent: number | null;
  /** Days in the range that have at least one completed set. */
  daysTrained: number;
}

export function computeTrainingStats(days: DayLog[]): TrainingStats {
  const stats: TrainingStats = {
    exerciseCount: 0,
    completedExercises: 0,
    plannedSetCount: 0,
    completedSetCount: 0,
    totalReps: 0,
    completionPercent: null,
    daysTrained: 0,
  };

  for (const day of days) {
    let dayHasWork = false;
    for (const exercise of day.exercises) {
      stats.exerciseCount += 1;
      stats.plannedSetCount += plannedSets(exercise);
      if (isExerciseComplete(exercise)) stats.completedExercises += 1;

      for (const set of exercise.sets) {
        if (!set.completed) continue;
        dayHasWork = true;
        stats.completedSetCount += 1;
        stats.totalReps += set.reps ?? 0;
      }
    }
    if (dayHasWork) stats.daysTrained += 1;
  }

  stats.completionPercent =
    stats.plannedSetCount > 0 ? (stats.completedSetCount / stats.plannedSetCount) * 100 : null;

  return stats;
}

export interface LiftProgress {
  name: string;
  best: number;
  previousBest: number | null;
  /** 'pr' beat the previous best, 'matched' within 1%, 'down' below it, 'new' no history. */
  verdict: 'pr' | 'matched' | 'down' | 'new';
  deltaPercent: number | null;
}

/**
 * Compares each lift trained in `days` against its best estimated 1RM from any
 * earlier session. This is the progression signal — whether the weight on the
 * bar is actually going up — which set counts and tonnage both miss.
 */
export function computeProgression(
  allDays: Record<string, DayLog>,
  days: DayLog[],
): LiftProgress[] {
  const dates = days.map((d) => d.date).sort();
  const earliest = dates[0];
  if (!earliest) return [];

  const bestThisRange = new Map<string, number>();
  for (const day of days) {
    for (const exercise of day.exercises) {
      const e = bestE1RM(exercise);
      if (e === null) continue;
      const key = exercise.name.trim().toLowerCase();
      bestThisRange.set(key, Math.max(bestThisRange.get(key) ?? 0, e));
    }
  }

  const results: LiftProgress[] = [];
  for (const [key, best] of bestThisRange) {
    const previousBest = previousBestE1RM(allDays, key, earliest);
    let verdict: LiftProgress['verdict'];
    let deltaPercent: number | null = null;
    if (previousBest === null) {
      verdict = 'new';
    } else {
      deltaPercent = ((best - previousBest) / previousBest) * 100;
      verdict = deltaPercent > 1 ? 'pr' : deltaPercent >= -1 ? 'matched' : 'down';
    }
    // Recover the original casing for display.
    const display =
      days.flatMap((d) => d.exercises).find((e) => e.name.trim().toLowerCase() === key)?.name ?? key;
    results.push({ name: display, best, previousBest, verdict, deltaPercent });
  }

  return results.sort((a, b) => (b.deltaPercent ?? 999) - (a.deltaPercent ?? 999));
}

/** Best e1RM for an exercise across every session strictly before `beforeISO`. */
export function previousBestE1RM(
  days: Record<string, DayLog>,
  name: string,
  beforeISO: string,
): number | null {
  let best: number | null = null;
  for (const [date, day] of Object.entries(days)) {
    if (date >= beforeISO) continue;
    for (const exercise of day.exercises) {
      if (exercise.name.trim().toLowerCase() !== name.trim().toLowerCase()) continue;
      const e = bestE1RM(exercise);
      if (e !== null && (best === null || e > best)) best = e;
    }
  }
  return best;
}

export interface ProgressionSummary {
  prs: number;
  matched: number;
  down: number;
  fresh: number;
  compared: number;
}

export function summarizeProgression(lifts: LiftProgress[]): ProgressionSummary {
  return {
    prs: lifts.filter((l) => l.verdict === 'pr').length,
    matched: lifts.filter((l) => l.verdict === 'matched').length,
    down: lifts.filter((l) => l.verdict === 'down').length,
    fresh: lifts.filter((l) => l.verdict === 'new').length,
    compared: lifts.filter((l) => l.verdict !== 'new').length,
  };
}
