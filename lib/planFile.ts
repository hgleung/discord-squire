import type { PlanData } from './types';
import { CURRENT_VERSION } from './types';
import { lookupMuscles } from './muscles';

/**
 * Parsing, validation, and version migration for plan files — no browser APIs,
 * so the Discord bot can share exactly the same rules as the web app.
 */

export class InvalidPlanFileError extends Error {}

/**
 * Plan files are hand-editable and survive across versions, so nothing that
 * comes off disk is trusted. Anything that fails these checks is rejected with
 * a message rather than being cast into the app and blanking the UI.
 */
export function parsePlanData(raw: string): PlanData {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new InvalidPlanFileError("that file isn't valid JSON.");
  }

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvalidPlanFileError('expected an object at the top level.');
  }

  const data = value as Partial<PlanData>;

  if (typeof data.version !== 'number') {
    throw new InvalidPlanFileError('missing a "version" field — is this a Squire file?');
  }
  if (data.version > CURRENT_VERSION) {
    throw new InvalidPlanFileError(
      `it was written by a newer version (v${data.version}); this app understands up to v${CURRENT_VERSION}.`,
    );
  }
  if (data.version < 2) {
    throw new InvalidPlanFileError(
      `it's a v${data.version} file from the old time-blocked planner, which has no set/rep data to import.`,
    );
  }

  if (typeof data.config !== 'object' || data.config === null) {
    throw new InvalidPlanFileError('missing its "config" section.');
  }
  if (typeof data.days !== 'object' || data.days === null || Array.isArray(data.days)) {
    throw new InvalidPlanFileError('missing its "days" section.');
  }
  if (!Array.isArray(data.templates)) {
    throw new InvalidPlanFileError('missing its "templates" list.');
  }
  if (!Array.isArray(data.quickAddExercises)) {
    throw new InvalidPlanFileError('missing its "quickAddExercises" list.');
  }

  for (const [date, day] of Object.entries(data.days)) {
    if (typeof day !== 'object' || day === null || !Array.isArray((day as { exercises?: unknown }).exercises)) {
      throw new InvalidPlanFileError(`the entry for ${date} has no exercise list.`);
    }
  }

  return migrate({
    version: data.version,
    config: {
      planName: data.config.planName ?? 'My training log',
      unit: data.config.unit === 'kg' ? 'kg' : 'lb',
      createdDate: data.config.createdDate ?? new Date().toISOString().slice(0, 10),
    },
    days: data.days,
    templates: data.templates,
    quickAddExercises: data.quickAddExercises,
  });
}

/** Fills in muscle tags for anything written before muscle tracking existed. */
function withMuscles<T extends { name: string; primaryMuscles?: unknown; secondaryMuscles?: unknown }>(
  item: T,
): T {
  if (Array.isArray(item.primaryMuscles) && Array.isArray(item.secondaryMuscles)) return item;
  const { primary, secondary } = lookupMuscles(item.name);
  return { ...item, primaryMuscles: primary, secondaryMuscles: secondary };
}

function migrate(data: PlanData): PlanData {
  if (data.version >= CURRENT_VERSION) return data;

  const days: PlanData['days'] = {};
  for (const [date, day] of Object.entries(data.days)) {
    days[date] = { ...day, exercises: day.exercises.map(withMuscles) };
  }

  return {
    ...data,
    version: CURRENT_VERSION,
    days,
    templates: data.templates.map((t) => ({ ...t, exercises: t.exercises.map(withMuscles) })),
    quickAddExercises: data.quickAddExercises.map(withMuscles),
  };
}
