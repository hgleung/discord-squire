import { escapeMarkdown as md } from 'discord.js';
import type { DayLog, PlanData } from '../../../lib/types.js';
import { formatDayHeading } from '../../../lib/dateUtils.js';
import { bestE1RM, completedSets, plannedSets } from '../../../lib/scoring.js';
import { lastPerformedSet } from '../../../lib/planOps.js';

/** Discord messages are read one-handed between sets — keep them short and scannable. */

export function formatSession(plan: PlanData, day: DayLog, dateISO: string): string {
  if (day.exercises.length === 0) {
    return [
      `**${formatDayHeading(dateISO)}** — nothing planned.`,
      ``,
      `Load a split with \`/split\`, or add exercises in the web app.`,
    ].join('\n');
  }

  const template = plan.templates.find((t) => t.id === day.templateId)?.name;
  const unit = plan.config.unit;

  const lines = day.exercises.map((e) => {
    const done = completedSets(e);
    const planned = plannedSets(e);
    const box = done >= planned ? '✅' : done > 0 ? '🔸' : '⬜';

    // Show what to aim for: last time's working weight, or what's logged today.
    const loggedToday = e.sets.filter((s) => s.completed && s.weight !== null);
    let hint: string;
    if (loggedToday.length > 0) {
      hint = loggedToday.map((s) => `${s.weight}×${s.reps}`).join(', ');
    } else {
      const last = lastPerformedSet(plan, e.name, dateISO);
      hint = last?.weight != null ? `last: ${last.weight} ${unit} × ${last.reps}` : 'no history';
    }

    return `${box} **${md(e.name)}** — ${done}/${planned} sets · target ${e.targetSets}×${e.targetReps}\n     ${hint}`;
  });

  const header = template
    ? `**${formatDayHeading(dateISO)}** · ${template}`
    : `**${formatDayHeading(dateISO)}**`;

  return [header, '', ...lines].join('\n');
}

export function formatLogged(
  exerciseName: string,
  weight: number,
  reps: number,
  unit: string,
  done: number,
  planned: number,
  e1rm: number | null,
  isPR: boolean,
): string {
  const parts = [`Logged **${md(exerciseName)}** ${weight} ${unit} × ${reps} — set ${done} of ${planned}.`];
  if (e1rm !== null) {
    parts.push(isPR ? `🏆 New best: ${Math.round(e1rm)} ${unit} e1RM.` : `e1RM ${Math.round(e1rm)} ${unit}.`);
  }
  if (done >= planned) parts.push(`That exercise is done.`);
  return parts.join(' ');
}

export function formatSplits(plan: PlanData): string {
  return [
    `**Splits**`,
    ...plan.templates.map((t) => `• **${md(t.name)}** — ${t.exercises.length} exercises · ${md(t.description)}`),
  ].join('\n');
}

export function bestE1RMFor(day: DayLog, name: string): number | null {
  const e = day.exercises.find((x) => x.name.toLowerCase() === name.toLowerCase());
  return e ? bestE1RM(e) : null;
}
