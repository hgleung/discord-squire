import { useMemo } from 'react';
import type { PlanData } from '../../../lib/types';
import { weekRangeLabel } from '../../../lib/dateUtils';
import { getOrEmptyDay, getWeekDays } from '../../../lib/planOps';
import {
  computeMuscleVolume,
  computeProgression,
  computeTrainingStats,
  summarizeProgression,
  volumeRating,
  volumeRatingLabel,
} from '../../../lib/scoring';
import { MUSCLE_LABEL } from '../../../lib/muscles';
import { MuscleVolumePanel } from './MuscleVolumePanel';
import { WeekSummaryPanel } from './WeekSummaryPanel';
import { StarRating } from './StarRating';

interface StatsPanelProps {
  plan: PlanData;
  selectedDate: string;
}

export function StatsPanel({ plan, selectedDate }: StatsPanelProps) {
  const weekDays = useMemo(() => getWeekDays(plan, selectedDate), [plan, selectedDate]);
  const weekStats = computeTrainingStats(weekDays);
  const muscleVolumes = useMemo(() => computeMuscleVolume(weekDays), [weekDays]);
  const lifts = useMemo(() => computeProgression(plan.days, weekDays), [plan.days, weekDays]);
  const progression = summarizeProgression(lifts);
  const dayLog = getOrEmptyDay(plan, selectedDate);
  const dayStats = computeTrainingStats([dayLog]);

  const rating = volumeRating(muscleVolumes);
  const unit = plan.config.unit;

  const allTime = useMemo(() => computeTrainingStats(Object.values(plan.days)), [plan.days]);
  const lagging = muscleVolumes.filter((v) => v.state === 'under').slice(0, 3);
  const movers = lifts.filter((l) => l.verdict === 'pr' || l.verdict === 'down').slice(0, 4);

  return (
    <div className="flex w-[300px] shrink-0 flex-col gap-4 overflow-y-auto border-l border-neutral-100 bg-white p-4">
      <section>
        <div className="mb-1 flex items-center justify-between">
          <span className="text-[11px] font-bold tracking-wide text-neutral-400">WEEKLY VOLUME</span>
          <span className="text-[11px] text-neutral-400">{weekRangeLabel(selectedDate)}</span>
        </div>
        <StarRating rating={rating} size={20} />
        <div className="mt-1 flex items-baseline gap-1.5">
          <span className="text-[28px] font-bold leading-none text-neutral-900">
            {rating === null ? '–' : rating.toFixed(1)}
          </span>
          <span className="text-[13px] text-neutral-400">/ 5 · hard sets vs target</span>
        </div>
        <div className="mt-0.5 text-[13px] font-medium text-neutral-600">{volumeRatingLabel(rating)}</div>

        {lagging.length > 0 && (
          <p className="mt-2 rounded-lg bg-amber-50 px-2 py-1.5 text-[11.5px] leading-relaxed text-amber-800">
            Below target: {lagging.map((v) => MUSCLE_LABEL[v.muscle]).join(', ')}
          </p>
        )}
      </section>

      <section>
        <MuscleVolumePanel volumes={muscleVolumes} />
        <p className="mt-2.5 text-[11.5px] leading-relaxed text-neutral-400">
          Hard sets per muscle this week. Ticks mark the productive range; the number after the slash is
          the weekly minimum.
        </p>
      </section>

      <section className="rounded-xl border border-neutral-100 p-3">
        <span className="text-[11px] font-bold tracking-wide text-neutral-400">THIS WEEK</span>
        <div className="mt-2 grid grid-cols-3 gap-2">
          <StatCard value={String(weekStats.daysTrained)} label="days trained" />
          <StatCard value={String(weekStats.completedSetCount)} label="sets done" />
          <StatCard
            value={progression.compared > 0 ? `${progression.prs}/${progression.compared}` : '–'}
            label="lifts up"
            tone={progression.prs > 0 ? 'good' : undefined}
          />
        </div>

        {movers.length > 0 && (
          <div className="mt-2.5 flex flex-col gap-1">
            {movers.map((l) => (
              <div key={l.name} className="flex items-baseline gap-2 text-[11.5px]">
                <span className="truncate text-neutral-600">{l.name}</span>
                <span
                  className={`ml-auto shrink-0 tabular-nums ${
                    l.verdict === 'pr' ? 'font-semibold text-emerald-600' : 'text-red-500'
                  }`}
                >
                  {l.deltaPercent! >= 0 ? '+' : ''}
                  {l.deltaPercent!.toFixed(1)}%
                </span>
                <span className="shrink-0 text-neutral-300 tabular-nums">
                  {Math.round(l.best)} {unit}
                </span>
              </div>
            ))}
          </div>
        )}

        <p className="mt-2 text-[11.5px] leading-relaxed text-neutral-400">
          "Lifts up" counts exercises whose estimated 1RM beat your previous best. That's the
          progression signal — total weight moved isn't, since it rises just by adding sets.
        </p>
      </section>

      <WeekSummaryPanel plan={plan} weekDays={weekDays} selectedDate={selectedDate} />

      <section className="rounded-xl border border-neutral-100 p-3">
        <span className="text-[11px] font-bold tracking-wide text-neutral-400">THIS DAY</span>
        <div className="mt-2 grid grid-cols-3 gap-2">
          <StatCard value={`${dayStats.completedSetCount}/${dayStats.plannedSetCount}`} label="sets" />
          <StatCard
            value={`${dayStats.completedExercises}/${dayStats.exerciseCount}`}
            label="exercises"
          />
          <StatCard value={String(dayStats.totalReps)} label="reps" />
        </div>
        {dayStats.exerciseCount === 0 && (
          <p className="mt-2 text-[11.5px] text-neutral-400">Rest day — nothing logged.</p>
        )}
      </section>

      <section className="rounded-xl border border-neutral-100 p-3">
        <span className="text-[11px] font-bold tracking-wide text-neutral-400">ALL TIME</span>
        <div className="mt-2 grid grid-cols-3 gap-2">
          <StatCard value={String(allTime.daysTrained)} label="sessions" />
          <StatCard value={String(allTime.completedSetCount)} label="sets" />
          <StatCard value={String(allTime.exerciseCount)} label="exercises" />
        </div>
      </section>
    </div>
  );
}

function StatCard({ value, label, tone }: { value: string; label: string; tone?: 'good' }) {
  return (
    <div className="rounded-lg bg-neutral-50 px-2 py-2 text-center">
      <div className={`text-[15px] font-bold ${tone === 'good' ? 'text-emerald-600' : 'text-neutral-800'}`}>
        {value}
      </div>
      <div className="text-[10px] text-neutral-400">{label}</div>
    </div>
  );
}
