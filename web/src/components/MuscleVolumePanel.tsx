import type { MuscleVolume } from '../../../lib/scoring';
import { MUSCLE_BUCKET, MUSCLE_LABEL } from '../../../lib/muscles';

const BUCKET_LABEL = { push: 'PUSH', pull: 'PULL', legs: 'LEGS' } as const;
const BUCKETS = ['push', 'pull', 'legs'] as const;

const STATE_BAR: Record<MuscleVolume['state'], string> = {
  untrained: 'bg-neutral-200',
  under: 'bg-amber-400',
  'in-range': 'bg-emerald-500',
  over: 'bg-orange-500',
};

interface MuscleVolumePanelProps {
  volumes: MuscleVolume[];
  /** Hide muscles with no sets logged, to keep the panel short mid-week. */
  hideUntrained?: boolean;
}

export function MuscleVolumePanel({ volumes, hideUntrained = false }: MuscleVolumePanelProps) {
  const byMuscle = new Map(volumes.map((v) => [v.muscle, v]));

  return (
    <div className="flex flex-col gap-2.5">
      {BUCKETS.map((bucket) => {
        const rows = volumes.filter(
          (v) => MUSCLE_BUCKET[v.muscle] === bucket && (!hideUntrained || v.sets > 0),
        );
        if (rows.length === 0) return null;

        return (
          <div key={bucket}>
            <div className="mb-1 text-[10px] font-bold tracking-wide text-neutral-300">
              {BUCKET_LABEL[bucket]}
            </div>
            <div className="flex flex-col gap-1">
              {rows.map((v) => (
                <MuscleRow key={v.muscle} volume={byMuscle.get(v.muscle) ?? v} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function MuscleRow({ volume }: { volume: MuscleVolume }) {
  const { muscle, sets, target, state } = volume;
  // Scale the bar so the target maximum sits at 80% width, leaving headroom
  // for overshoot to be visible rather than clipped.
  const scale = target.max / 0.8;
  const pct = Math.min(100, (sets / scale) * 100);
  const minMark = (target.min / scale) * 100;
  const maxMark = (target.max / scale) * 100;

  return (
    <div className="flex items-center gap-2">
      <span className="w-[76px] shrink-0 text-[11px] text-neutral-500">{MUSCLE_LABEL[muscle]}</span>
      <div className="relative h-2.5 flex-1 overflow-hidden rounded-full bg-neutral-100">
        <div className={`h-full rounded-full ${STATE_BAR[state]}`} style={{ width: `${pct}%` }} />
        <span className="absolute top-0 h-full w-px bg-neutral-300/80" style={{ left: `${minMark}%` }} />
        <span className="absolute top-0 h-full w-px bg-neutral-300/80" style={{ left: `${maxMark}%` }} />
      </div>
      <span
        className={`w-[54px] shrink-0 text-right text-[11px] tabular-nums ${
          state === 'in-range'
            ? 'text-emerald-600'
            : state === 'under'
              ? 'text-amber-600'
              : state === 'over'
                ? 'text-orange-600'
                : 'text-neutral-300'
        }`}
      >
        {sets === 0 ? '–' : sets}
        <span className="text-neutral-300">/{target.min}</span>
      </span>
    </div>
  );
}
