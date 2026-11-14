import type { MuscleGroup } from './muscles';

export type ExerciseColor =
  | 'green'
  | 'yellow'
  | 'blue'
  | 'orange'
  | 'purple'
  | 'pink'
  | 'teal'
  | 'red';

export type WeightUnit = 'lb' | 'kg';

/** One working set. `weight` is null for bodyweight or unrecorded work. */
export interface SetEntry {
  id: string;
  weight: number | null;
  reps: number | null;
  completed: boolean;
}

export interface Exercise {
  id: string;
  name: string;
  emoji: string;
  color: ExerciseColor;
  /** What was planned, so a partly-finished exercise is still legible. */
  targetSets: number;
  targetReps: string; // free text: "6", "8-10", "AMRAP"
  /** Muscles this directly trains — a completed set counts fully toward each. */
  primaryMuscles: MuscleGroup[];
  /** Assisting muscles — a completed set counts as a half set toward each. */
  secondaryMuscles: MuscleGroup[];
  sets: SetEntry[];
  note?: string;
}

export interface DayLog {
  date: string; // YYYY-MM-DD
  exercises: Exercise[];
  templateId?: string;
}

export interface TemplateExercise {
  name: string;
  emoji: string;
  color: ExerciseColor;
  targetSets: number;
  targetReps: string;
  primaryMuscles: MuscleGroup[];
  secondaryMuscles: MuscleGroup[];
}

export interface WorkoutTemplate {
  id: string;
  name: string;
  description: string;
  exercises: TemplateExercise[];
  isBuiltin?: boolean;
}

export interface QuickAddExercise extends TemplateExercise {
  id: string;
}

export interface PlanConfig {
  planName: string;
  unit: WeightUnit;
  /** Date the log was created — used only for "training since", not as a deadline. */
  createdDate: string;
}

export interface PlanData {
  version: number;
  config: PlanConfig;
  days: Record<string, DayLog>;
  templates: WorkoutTemplate[];
  quickAddExercises: QuickAddExercise[];
}

export const CURRENT_VERSION = 3;
