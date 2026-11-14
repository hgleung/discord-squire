export type MuscleGroup =
  | 'chest'
  | 'frontDelts'
  | 'sideDelts'
  | 'rearDelts'
  | 'triceps'
  | 'lats'
  | 'upperBack'
  | 'traps'
  | 'biceps'
  | 'forearms'
  | 'quads'
  | 'hamstrings'
  | 'glutes'
  | 'calves'
  | 'core';

export const MUSCLE_ORDER: MuscleGroup[] = [
  'chest',
  'frontDelts',
  'sideDelts',
  'rearDelts',
  'triceps',
  'lats',
  'upperBack',
  'traps',
  'biceps',
  'forearms',
  'quads',
  'hamstrings',
  'glutes',
  'calves',
  'core',
];

export const MUSCLE_LABEL: Record<MuscleGroup, string> = {
  chest: 'Chest',
  frontDelts: 'Front delts',
  sideDelts: 'Side delts',
  rearDelts: 'Rear delts',
  triceps: 'Triceps',
  lats: 'Lats',
  upperBack: 'Upper back',
  traps: 'Traps',
  biceps: 'Biceps',
  forearms: 'Forearms',
  quads: 'Quads',
  hamstrings: 'Hamstrings',
  glutes: 'Glutes',
  calves: 'Calves',
  core: 'Core',
};

/** Which day of a push/pull/legs split a muscle belongs to — used for grouping the UI. */
export const MUSCLE_BUCKET: Record<MuscleGroup, 'push' | 'pull' | 'legs'> = {
  chest: 'push',
  frontDelts: 'push',
  sideDelts: 'push',
  triceps: 'push',
  rearDelts: 'pull',
  lats: 'pull',
  upperBack: 'pull',
  traps: 'pull',
  biceps: 'pull',
  forearms: 'pull',
  quads: 'legs',
  hamstrings: 'legs',
  glutes: 'legs',
  calves: 'legs',
  core: 'legs',
};

/**
 * Weekly hard-set targets per muscle group. `min` is roughly the minimum
 * effective volume to keep making progress; `max` is the point past which
 * most people stop recovering from the extra work.
 */
export interface VolumeTarget {
  min: number;
  max: number;
}

export const MUSCLE_TARGETS: Record<MuscleGroup, VolumeTarget> = {
  chest: { min: 10, max: 20 },
  frontDelts: { min: 6, max: 12 },
  sideDelts: { min: 8, max: 20 },
  rearDelts: { min: 8, max: 16 },
  triceps: { min: 8, max: 16 },
  lats: { min: 10, max: 20 },
  upperBack: { min: 10, max: 20 },
  traps: { min: 6, max: 16 },
  biceps: { min: 8, max: 16 },
  forearms: { min: 4, max: 12 },
  quads: { min: 10, max: 20 },
  hamstrings: { min: 8, max: 16 },
  glutes: { min: 8, max: 16 },
  calves: { min: 8, max: 16 },
  core: { min: 6, max: 16 },
};

/** A set counts fully for the muscles it directly trains, half for assisting ones. */
export const SECONDARY_SET_WEIGHT = 0.5;

interface MuscleMapping {
  primary: MuscleGroup[];
  secondary: MuscleGroup[];
}

/**
 * Muscle mapping for the exercises shipped in the built-in splits. Also used to
 * backfill muscle data when loading a plan file written before muscle tracking
 * existed.
 */
export const EXERCISE_LIBRARY: Record<string, MuscleMapping> = {
  'barbell bench press': { primary: ['chest'], secondary: ['frontDelts', 'triceps'] },
  'incline dumbbell press': { primary: ['chest', 'frontDelts'], secondary: ['triceps'] },
  'overhead press': { primary: ['frontDelts'], secondary: ['sideDelts', 'triceps'] },
  'lateral raise': { primary: ['sideDelts'], secondary: [] },
  'triceps pushdown': { primary: ['triceps'], secondary: [] },
  'rope pushdown': { primary: ['triceps'], secondary: [] },
  'overhead triceps extension': { primary: ['triceps'], secondary: [] },
  deadlift: { primary: ['hamstrings', 'glutes'], secondary: ['upperBack', 'traps', 'forearms'] },
  'pull-up / lat pulldown': { primary: ['lats'], secondary: ['biceps', 'upperBack', 'forearms'] },
  'barbell row': { primary: ['upperBack', 'lats'], secondary: ['biceps', 'rearDelts', 'forearms'] },
  'seated cable row': { primary: ['upperBack'], secondary: ['lats', 'biceps'] },
  'cable row': { primary: ['upperBack'], secondary: ['lats', 'biceps'] },
  'face pull': { primary: ['rearDelts'], secondary: ['upperBack', 'traps'] },
  'barbell curl': { primary: ['biceps'], secondary: ['forearms'] },
  'dumbbell curl': { primary: ['biceps'], secondary: ['forearms'] },
  'back squat': { primary: ['quads'], secondary: ['glutes', 'core'] },
  'romanian deadlift': { primary: ['hamstrings'], secondary: ['glutes', 'upperBack'] },
  'leg press': { primary: ['quads'], secondary: ['glutes'] },
  'leg curl': { primary: ['hamstrings'], secondary: [] },
  'leg extension': { primary: ['quads'], secondary: [] },
  'standing calf raise': { primary: ['calves'], secondary: [] },
  'hanging leg raise': { primary: ['core'], secondary: ['forearms'] },
  plank: { primary: ['core'], secondary: [] },
  'core circuit': { primary: ['core'], secondary: [] },
  'incline walk': { primary: [], secondary: [] },
  'incline walk / cardio': { primary: [], secondary: [] },
  'full-body mobility': { primary: [], secondary: [] },
  'stretch / mobility': { primary: [], secondary: [] },
};

export function lookupMuscles(name: string): MuscleMapping {
  return EXERCISE_LIBRARY[name.trim().toLowerCase()] ?? { primary: [], secondary: [] };
}
