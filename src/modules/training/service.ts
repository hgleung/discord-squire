import type { PlanStore } from './store.js';
import { formatLogged, formatSession, formatSplits } from './format.js';
import { shiftDateISO, toISODate } from '../../../lib/dateUtils.js';
import { applyTemplateToDay, blankSet, getOrEmptyDay, getWeekDays, updateSet } from '../../../lib/planOps.js';
import { bestE1RM, completedSets, plannedSets, previousBestE1RM } from '../../../lib/scoring.js';
import { buildWeekFacts } from '../../../lib/weekSummary.js';
import { createNewPlan } from '../../../lib/defaults.js';
import type { PlanData } from '../../../lib/types.js';

/** A request the log can't carry out, worded for the person who made it. */
export class TrainingError extends Error {}

/**
 * The training log's operations, shared by the slash commands and the chat
 * assistant so the two can never disagree about what "log a set" means. Every
 * write goes through the PlanStore, so the web UI sees it immediately too.
 */
export class TrainingService {
  constructor(
    readonly store: PlanStore,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  today(): string {
    return toISODate(this.clock());
  }

  /**
   * The web app's first-run screen normally creates the plan. Coming to Discord
   * first shouldn't be a dead end, so create a default on demand.
   */
  ensurePlan(): PlanData {
    if (this.store.exists()) return this.store.load();
    this.store.init(createNewPlan('My training log', 'lb', this.today()));
    // The stored copy, not the argument: its ids are the ones later writes match on.
    return this.store.load();
  }

  session(date = this.today()): string {
    const plan = this.ensurePlan();
    return formatSession(plan, getOrEmptyDay(plan, date), date);
  }

  splits(): string {
    return formatSplits(this.ensurePlan());
  }

  /** Fills the next unticked set of an exercise in the day's session, or appends one. */
  logSet(name: string, weight: number, reps: number, date = this.today()): string {
    const plan = this.ensurePlan();
    const day = getOrEmptyDay(plan, date);
    const exercise = day.exercises.find((e) => e.name.toLowerCase() === name.toLowerCase());
    if (!exercise) {
      const names = day.exercises.map((e) => e.name);
      throw new TrainingError(
        names.length
          ? `**${name}** isn't in that day's session. It has: ${names.join(', ')}.`
          : `Nothing is loaded for ${date} yet. Load a split first.`,
      );
    }

    // Fill the first set not yet ticked off; if all are done, append one so
    // extra sets beyond the plan are still recorded.
    const target = exercise.sets.find((s) => !s.completed);
    // "New best" means better than anything before this set — earlier
    // sessions and earlier sets today alike. Comparing against past
    // sessions only would flag every set of a first session as a PR.
    const earlierToday = bestE1RM(exercise);
    const past = previousBestE1RM(plan.days, exercise.name, date);
    const previousBest = earlierToday === null ? past : past === null ? earlierToday : Math.max(past, earlierToday);

    const next = this.store.update((p) => {
      if (target) return updateSet(p, date, exercise.id, target.id, { weight, reps, completed: true });
      const d = getOrEmptyDay(p, date);
      return {
        ...p,
        days: {
          ...p.days,
          [date]: {
            ...d,
            exercises: d.exercises.map((e) =>
              e.id === exercise.id ? { ...e, sets: [...e.sets, { ...blankSet(), weight, reps, completed: true }] } : e,
            ),
          },
        },
      };
    });

    const updated = getOrEmptyDay(next, date).exercises.find((e) => e.id === exercise.id)!;
    const e1rm = bestE1RM(updated);
    return formatLogged(
      updated.name, weight, reps, next.config.unit,
      completedSets(updated), plannedSets(updated),
      e1rm, e1rm !== null && (previousBest === null || e1rm > previousBest),
    );
  }

  /** Loads a split into a day, refusing if that would throw away logged sets. */
  loadSplit(name: string, date = this.today()): string {
    const plan = this.ensurePlan();
    const template = plan.templates.find((t) => t.name.toLowerCase() === name.toLowerCase());
    if (!template) {
      throw new TrainingError(`No split called **${name}**. The splits are: ${plan.templates.map((t) => t.name).join(', ')}.`);
    }
    const existing = getOrEmptyDay(plan, date);
    if (existing.exercises.some((e) => e.sets.some((s) => s.completed))) {
      throw new TrainingError(
        `That day already has logged sets — loading **${template.name}** would discard them. Clear the day in the web app first.`,
      );
    }
    const next = this.store.update((p) => applyTemplateToDay(p, date, template.id));
    return formatSession(next, getOrEmptyDay(next, date), date);
  }

  /** The last `days` days that have anything in them, oldest first, as compact text. */
  history(days: number, end = this.today()): string {
    const plan = this.ensurePlan();
    const unit = plan.config.unit;
    const lines: string[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const date = shiftDateISO(end, -i);
      const day = plan.days[date];
      if (!day || day.exercises.length === 0) continue;
      const template = plan.templates.find((t) => t.id === day.templateId)?.name ?? 'Custom session';
      const exercises = day.exercises.map((e) => {
        const done = e.sets.filter((s) => s.completed);
        const sets = done.length ? done.map((s) => (s.weight === null ? `${s.reps}` : `${s.weight}×${s.reps}`)).join(', ') : 'none logged';
        return `  - ${e.name} (target ${e.targetSets}×${e.targetReps}): ${sets}`;
      });
      lines.push(`${date} · ${template}\n${exercises.join('\n')}`);
    }
    return lines.length ? `Weights in ${unit}.\n${lines.join('\n')}` : `Nothing logged in the last ${days} days.`;
  }

  /** This week's computed numbers: sessions, sets per muscle vs target, lift progression. */
  weekFacts(date = this.today()): string {
    const plan = this.ensurePlan();
    const weekDays = getWeekDays(plan, date);
    if (!weekDays.some((d) => d.exercises.length > 0)) return 'Nothing logged this week yet.';
    return buildWeekFacts(plan, weekDays, date);
  }
}
