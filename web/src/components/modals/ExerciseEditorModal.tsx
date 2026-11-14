import { useState } from 'react';
import type { Exercise, ExerciseColor } from '../../../../lib/types';
import { COLOR_MAP } from '../../lib/colors';
import { lookupMuscles } from '../../../../lib/muscles';
import { MusclePicker } from '../MusclePicker';
import { Modal } from '../Modal';

const COLORS: ExerciseColor[] = ['green', 'yellow', 'blue', 'orange', 'purple', 'pink', 'teal', 'red'];
const EMOJI_SUGGESTIONS = ['🏋️', '💪', '🦵', '🧱', '🧘', '🚶', '🚴', '🤸', '⚡', '🔥'];

interface ExerciseEditorModalProps {
  exercise: Exercise;
  isNew: boolean;
  onSave: (exercise: Exercise) => void;
  onDelete: () => void;
  onClose: () => void;
}

export function ExerciseEditorModal({
  exercise,
  isNew,
  onSave,
  onDelete,
  onClose,
}: ExerciseEditorModalProps) {
  const [form, setForm] = useState<Exercise>(exercise);

  const set = <K extends keyof Exercise>(key: K, value: Exercise[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  return (
    <Modal title={isNew ? 'New exercise' : 'Edit exercise'} onClose={onClose}>
      <div className="flex flex-col gap-3">
        <div className="flex gap-2">
          <input
            value={form.emoji}
            onChange={(e) => set('emoji', e.target.value)}
            className="w-14 rounded-lg border border-neutral-200 px-2 py-2 text-center text-[16px]"
            maxLength={2}
          />
          <input
            value={form.name}
            onChange={(e) => {
              const name = e.target.value;
              // Auto-tag known lifts, but never clobber tags already chosen.
              setForm((f) => {
                if (f.primaryMuscles.length > 0 || f.secondaryMuscles.length > 0) return { ...f, name };
                const { primary, secondary } = lookupMuscles(name);
                return { ...f, name, primaryMuscles: primary, secondaryMuscles: secondary };
              });
            }}
            placeholder="Exercise name"
            autoFocus
            className="flex-1 rounded-lg border border-neutral-200 px-3 py-2 text-[14px]"
          />
        </div>

        <div className="flex flex-wrap gap-1.5">
          {EMOJI_SUGGESTIONS.map((e) => (
            <button
              key={e}
              onClick={() => set('emoji', e)}
              className="flex h-7 w-7 items-center justify-center rounded-md text-[14px] hover:bg-neutral-100"
            >
              {e}
            </button>
          ))}
        </div>

        <div className="flex gap-2">
          <label className="flex-1 text-[12px] text-neutral-500">
            Target sets
            <input
              type="number"
              min={1}
              max={20}
              value={form.targetSets}
              onChange={(e) => set('targetSets', Math.max(1, Number(e.target.value) || 1))}
              className="mt-1 w-full rounded-lg border border-neutral-200 px-2 py-1.5 text-[13px]"
            />
          </label>
          <label className="flex-1 text-[12px] text-neutral-500">
            Target reps
            <input
              value={form.targetReps}
              onChange={(e) => set('targetReps', e.target.value)}
              placeholder="8-10"
              className="mt-1 w-full rounded-lg border border-neutral-200 px-2 py-1.5 text-[13px]"
            />
          </label>
        </div>

        <div>
          <div className="mb-1 text-[12px] text-neutral-500">Muscles worked</div>
          <MusclePicker
            primary={form.primaryMuscles}
            secondary={form.secondaryMuscles}
            onChange={(primary, secondary) =>
              setForm((f) => ({ ...f, primaryMuscles: primary, secondaryMuscles: secondary }))
            }
          />
        </div>

        <div>
          <div className="mb-1 text-[12px] text-neutral-500">Color</div>
          <div className="flex flex-wrap gap-2">
            {COLORS.map((c) => (
              <button
                key={c}
                onClick={() => set('color', c)}
                aria-label={c}
                className={`h-6 w-6 rounded-full ${form.color === c ? 'ring-2 ring-neutral-400 ring-offset-2' : ''}`}
                style={{ backgroundColor: COLOR_MAP[c].base }}
              />
            ))}
          </div>
        </div>

        <label className="text-[12px] text-neutral-500">
          Note
          <textarea
            value={form.note ?? ''}
            onChange={(e) => set('note', e.target.value)}
            rows={2}
            placeholder="Cues, tempo, how it felt…"
            className="mt-1 w-full resize-none rounded-lg border border-neutral-200 px-2 py-1.5 text-[13px]"
          />
        </label>

        <div className="mt-2 flex items-center justify-between">
          {!isNew ? (
            <button onClick={onDelete} className="text-[13px] font-medium text-red-500 hover:underline">
              Delete
            </button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="rounded-lg border border-neutral-200 px-3.5 py-1.5 text-[13px] font-medium text-neutral-600"
            >
              Cancel
            </button>
            <button
              onClick={() => form.name.trim() && onSave(form)}
              className="rounded-lg bg-violet-600 px-3.5 py-1.5 text-[13px] font-medium text-white hover:bg-violet-700"
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
