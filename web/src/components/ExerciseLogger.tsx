import type { DayLog, Exercise, SetEntry, WeightUnit } from '../../../lib/types';
import { accentStyle, tintStyle } from '../lib/colors';
import { MUSCLE_LABEL } from '../../../lib/muscles';
import { bestE1RM, completedSets, isExerciseComplete, plannedSets } from '../../../lib/scoring';

interface ExerciseLoggerProps {
  day: DayLog;
  unit: WeightUnit;
  /** Best e1RM for each exercise name before today, for PR detection. */
  previousBests: Record<string, number | null>;
  onEditExercise: (exercise: Exercise) => void;
  onDeleteExercise: (exerciseId: string) => void;
  onMoveExercise: (exerciseId: string, delta: number) => void;
  onUpdateSet: (exerciseId: string, setId: string, patch: Partial<SetEntry>) => void;
  onAddSet: (exerciseId: string) => void;
  onRemoveSet: (exerciseId: string, setId: string) => void;
  onAddExercise: () => void;
}

export function ExerciseLogger({
  day,
  unit,
  previousBests,
  onEditExercise,
  onDeleteExercise,
  onMoveExercise,
  onUpdateSet,
  onAddSet,
  onRemoveSet,
  onAddExercise,
}: ExerciseLoggerProps) {
  if (day.exercises.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 bg-white p-8 text-center">
        <div className="text-[40px]">🏋️</div>
        <p className="text-[14px] font-medium text-neutral-700">Nothing logged for this day</p>
        <p className="max-w-[320px] text-[12.5px] text-neutral-400">
          Pick a split on the left to load its exercises, or add a single exercise.
        </p>
        <button
          onClick={onAddExercise}
          className="mt-1 rounded-lg bg-neutral-900 px-3 py-1.5 text-[12.5px] font-medium text-white hover:bg-neutral-700"
        >
          + Add exercise
        </button>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto bg-neutral-50/60 p-4">
      <div className="mx-auto flex max-w-[720px] flex-col gap-3">
        {day.exercises.map((exercise, idx) => (
          <ExerciseCard
            key={exercise.id}
            exercise={exercise}
            unit={unit}
            previousBest={previousBests[exercise.name.trim().toLowerCase()] ?? null}
            isFirst={idx === 0}
            isLast={idx === day.exercises.length - 1}
            onEdit={() => onEditExercise(exercise)}
            onDelete={() => onDeleteExercise(exercise.id)}
            onMove={(delta) => onMoveExercise(exercise.id, delta)}
            onUpdateSet={(setId, patch) => onUpdateSet(exercise.id, setId, patch)}
            onAddSet={() => onAddSet(exercise.id)}
            onRemoveSet={(setId) => onRemoveSet(exercise.id, setId)}
          />
        ))}

        <button
          onClick={onAddExercise}
          className="rounded-xl border border-dashed border-neutral-200 py-2.5 text-[12.5px] font-medium text-neutral-400 hover:border-neutral-300 hover:text-neutral-600"
        >
          + Add exercise
        </button>
      </div>
    </div>
  );
}

interface ExerciseCardProps {
  exercise: Exercise;
  unit: WeightUnit;
  previousBest: number | null;
  isFirst: boolean;
  isLast: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onMove: (delta: number) => void;
  onUpdateSet: (setId: string, patch: Partial<SetEntry>) => void;
  onAddSet: () => void;
  onRemoveSet: (setId: string) => void;
}

function ExerciseCard({
  exercise,
  unit,
  previousBest,
  isFirst,
  isLast,
  onEdit,
  onDelete,
  onMove,
  onUpdateSet,
  onAddSet,
  onRemoveSet,
}: ExerciseCardProps) {
  const done = completedSets(exercise);
  const planned = plannedSets(exercise);
  const complete = isExerciseComplete(exercise);
  const todayBest = bestE1RM(exercise);
  const isPR = todayBest !== null && (previousBest === null || todayBest > previousBest);

  return (
    <div
      className={`rounded-xl border border-l-[3px] bg-white shadow-sm transition ${
        complete ? 'border-neutral-100' : 'border-neutral-100'
      }`}
      style={accentStyle(exercise.color)}
    >
      <div className="flex items-center gap-2 px-3 pt-2.5">
        <span className="text-[15px] leading-none">{exercise.emoji}</span>
        <button onClick={onEdit} className="truncate text-left text-[13.5px] font-semibold text-neutral-800 hover:underline">
          {exercise.name || 'Untitled exercise'}
        </button>
        <span
          className="ml-1 shrink-0 rounded px-1.5 py-[1px] text-[10px] font-semibold"
          style={tintStyle(exercise.color)}
        >
          {exercise.targetSets}×{exercise.targetReps}
        </span>

        {exercise.primaryMuscles.length > 0 ? (
          <span className="truncate text-[10.5px] text-neutral-400">
            {exercise.primaryMuscles.map((m) => MUSCLE_LABEL[m]).join(' · ')}
          </span>
        ) : (
          <button
            onClick={onEdit}
            title="Tag muscles so these sets count toward your weekly volume"
            className="shrink-0 rounded bg-amber-50 px-1.5 py-[1px] text-[10px] font-medium text-amber-700 hover:bg-amber-100"
          >
            ⚠ untagged
          </button>
        )}

        <span
          className={`ml-auto shrink-0 rounded px-1.5 py-[1px] text-[10px] font-bold ${
            complete ? 'bg-emerald-500 text-white' : 'bg-neutral-100 text-neutral-500'
          }`}
        >
          {done}/{planned} sets
        </span>

        <div className="flex shrink-0 items-center gap-0.5 text-neutral-300">
          <IconBtn label="Move up" disabled={isFirst} onClick={() => onMove(-1)}>↑</IconBtn>
          <IconBtn label="Move down" disabled={isLast} onClick={() => onMove(1)}>↓</IconBtn>
          <IconBtn label="Delete exercise" onClick={onDelete}>✕</IconBtn>
        </div>
      </div>

      <div className="px-3 pb-1 pt-1">
        <div className="grid grid-cols-[28px_1fr_1fr_36px_28px] items-center gap-2 pb-1 text-[10px] font-semibold tracking-wide text-neutral-300">
          <span>SET</span>
          <span>WEIGHT ({unit})</span>
          <span>REPS</span>
          <span className="text-center">DONE</span>
          <span />
        </div>

        {exercise.sets.map((set, i) => (
          <div key={set.id} className="grid grid-cols-[28px_1fr_1fr_36px_28px] items-center gap-2 py-[3px]">
            <span className="text-[12px] font-medium text-neutral-400">{i + 1}</span>
            <NumberField
              value={set.weight}
              placeholder="–"
              onChange={(v) => onUpdateSet(set.id, { weight: v })}
            />
            <NumberField
              value={set.reps}
              placeholder="–"
              onChange={(v) => onUpdateSet(set.id, { reps: v })}
            />
            <button
              onClick={() => onUpdateSet(set.id, { completed: !set.completed })}
              aria-label={set.completed ? 'Mark set incomplete' : 'Mark set complete'}
              aria-pressed={set.completed}
              className={`mx-auto flex h-5 w-5 items-center justify-center rounded-md border text-[11px] transition ${
                set.completed
                  ? 'border-emerald-500 bg-emerald-500 text-white'
                  : 'border-neutral-200 text-transparent hover:border-neutral-300'
              }`}
            >
              ✓
            </button>
            <IconBtn label="Remove set" onClick={() => onRemoveSet(set.id)}>✕</IconBtn>
          </div>
        ))}

        <div className="flex items-center justify-between py-1.5">
          <button
            onClick={onAddSet}
            className="rounded-md px-1.5 py-0.5 text-[11.5px] font-medium text-neutral-400 hover:bg-neutral-50 hover:text-neutral-700"
          >
            + Add set
          </button>
          <div className="flex items-center gap-2 text-[11px] text-neutral-400">
            {todayBest !== null && (
              <span className={isPR ? 'font-semibold text-emerald-600' : ''}>
                {isPR && '🏆 '}e1RM {Math.round(todayBest)} {unit}
                {previousBest !== null && (
                  <span className="ml-1 font-normal text-neutral-300">
                    prev {Math.round(previousBest)}
                  </span>
                )}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function NumberField({
  value,
  placeholder,
  onChange,
}: {
  value: number | null;
  placeholder: string;
  onChange: (v: number | null) => void;
}) {
  return (
    <input
      type="number"
      inputMode="decimal"
      min={0}
      value={value ?? ''}
      placeholder={placeholder}
      onChange={(e) => {
        const raw = e.target.value;
        onChange(raw === '' ? null : Number(raw));
      }}
      className="w-full rounded-md border border-neutral-200 px-2 py-1 text-[12.5px] text-neutral-800 outline-none focus:border-neutral-400"
    />
  );
}

function IconBtn({
  children,
  label,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="flex h-5 w-5 items-center justify-center rounded text-[11px] text-neutral-300 hover:bg-neutral-100 hover:text-neutral-600 disabled:opacity-30 disabled:hover:bg-transparent"
    >
      {children}
    </button>
  );
}
