import type { MuscleGroup } from '../../../lib/muscles';
import { MUSCLE_BUCKET, MUSCLE_LABEL, MUSCLE_ORDER } from '../../../lib/muscles';

const BUCKETS = ['push', 'pull', 'legs'] as const;
const BUCKET_LABEL = { push: 'Push', pull: 'Pull', legs: 'Legs' } as const;

interface MusclePickerProps {
  primary: MuscleGroup[];
  secondary: MuscleGroup[];
  onChange: (primary: MuscleGroup[], secondary: MuscleGroup[]) => void;
}

/**
 * Click cycles a muscle through off → primary → secondary → off, so both
 * levels are reachable without a second control.
 */
export function MusclePicker({ primary, secondary, onChange }: MusclePickerProps) {
  const cycle = (m: MuscleGroup) => {
    if (primary.includes(m)) {
      onChange(
        primary.filter((x) => x !== m),
        [...secondary, m],
      );
    } else if (secondary.includes(m)) {
      onChange(
        primary,
        secondary.filter((x) => x !== m),
      );
    } else {
      onChange([...primary, m], secondary);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      {BUCKETS.map((bucket) => (
        <div key={bucket}>
          <div className="mb-1 text-[10px] font-bold tracking-wide text-neutral-300">
            {BUCKET_LABEL[bucket].toUpperCase()}
          </div>
          <div className="flex flex-wrap gap-1">
            {MUSCLE_ORDER.filter((m) => MUSCLE_BUCKET[m] === bucket).map((m) => {
              const isPrimary = primary.includes(m);
              const isSecondary = secondary.includes(m);
              return (
                <button
                  key={m}
                  onClick={() => cycle(m)}
                  aria-pressed={isPrimary || isSecondary}
                  title={
                    isPrimary ? 'Primary — click for secondary' : isSecondary ? 'Secondary — click to clear' : 'Click to set primary'
                  }
                  className={`rounded-md border px-1.5 py-[3px] text-[11px] font-medium transition ${
                    isPrimary
                      ? 'border-violet-400 bg-violet-500 text-white'
                      : isSecondary
                        ? 'border-violet-200 bg-violet-50 text-violet-600'
                        : 'border-neutral-200 text-neutral-400 hover:border-neutral-300'
                  }`}
                >
                  {MUSCLE_LABEL[m]}
                  {isSecondary && <span className="ml-0.5 opacity-60">½</span>}
                </button>
              );
            })}
          </div>
        </div>
      ))}
      <p className="text-[11px] text-neutral-400">
        Click once for primary (full set), twice for secondary (half set), a third time to clear.
      </p>
    </div>
  );
}
