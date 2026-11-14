import { useState } from 'react';
import { v4 as uuid } from 'uuid';
import type { ExerciseColor, TemplateExercise, WorkoutTemplate } from '../../../../lib/types';
import { dotColor } from '../../lib/colors';
import { MUSCLE_LABEL, lookupMuscles } from '../../../../lib/muscles';
import { MusclePicker } from '../MusclePicker';
import { Modal } from '../Modal';

const COLORS: ExerciseColor[] = ['green', 'yellow', 'blue', 'orange', 'purple', 'pink', 'teal', 'red'];

interface TemplateManagerModalProps {
  templates: WorkoutTemplate[];
  onSave: (template: WorkoutTemplate) => void;
  onDelete: (templateId: string) => void;
  onClose: () => void;
}

function blankTemplate(): WorkoutTemplate {
  return { id: uuid(), name: '', description: '', exercises: [] };
}

function blankExercise(): TemplateExercise {
  return {
    name: '',
    emoji: '🏋️',
    color: 'blue',
    targetSets: 3,
    targetReps: '10',
    primaryMuscles: [],
    secondaryMuscles: [],
  };
}

export function TemplateManagerModal({ templates, onSave, onDelete, onClose }: TemplateManagerModalProps) {
  const [editing, setEditing] = useState<WorkoutTemplate | null>(null);

  if (editing) {
    return (
      <TemplateEditor
        template={editing}
        onCancel={() => setEditing(null)}
        onSave={(t) => {
          onSave(t);
          setEditing(null);
        }}
      />
    );
  }

  return (
    <Modal title="Manage splits" onClose={onClose} width={520}>
      <div className="flex flex-col gap-2">
        {templates.map((t) => (
          <div key={t.id} className="flex items-center gap-2 rounded-xl border border-neutral-100 p-2.5">
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-semibold text-neutral-800">{t.name || 'Untitled'}</div>
              <div className="truncate text-[11px] text-neutral-400">
                {t.description} · {t.exercises.length} exercises
              </div>
            </div>
            <button
              onClick={() => setEditing(t)}
              className="rounded-lg border border-neutral-200 px-2.5 py-1 text-[12px] font-medium text-neutral-600 hover:bg-neutral-50"
            >
              Edit
            </button>
            <button
              onClick={() => window.confirm(`Delete "${t.name}"?`) && onDelete(t.id)}
              className="rounded-lg border border-neutral-200 px-2.5 py-1 text-[12px] font-medium text-red-500 hover:bg-red-50"
            >
              Delete
            </button>
          </div>
        ))}

        <button
          onClick={() => setEditing(blankTemplate())}
          className="mt-1 rounded-lg border border-dashed border-neutral-300 py-2 text-[13px] font-medium text-neutral-500 hover:bg-neutral-50"
        >
          + New split
        </button>
      </div>
    </Modal>
  );
}

function TemplateEditor({
  template,
  onSave,
  onCancel,
}: {
  template: WorkoutTemplate;
  onSave: (t: WorkoutTemplate) => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<WorkoutTemplate>(template);
  const [expanded, setExpanded] = useState<number | null>(null);

  const updateExercise = (idx: number, patch: Partial<TemplateExercise>) => {
    setForm((f) => ({
      ...f,
      exercises: f.exercises.map((e, i) => (i === idx ? { ...e, ...patch } : e)),
    }));
  };
  const removeExercise = (idx: number) =>
    setForm((f) => ({ ...f, exercises: f.exercises.filter((_, i) => i !== idx) }));
  const addExercise = () => setForm((f) => ({ ...f, exercises: [...f.exercises, blankExercise()] }));

  return (
    <Modal title={template.name ? `Edit "${template.name}"` : 'New split'} onClose={onCancel} width={560}>
      <div className="flex flex-col gap-3">
        <input
          value={form.name}
          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          placeholder="Split name (e.g. Push day)"
          className="rounded-lg border border-neutral-200 px-3 py-2 text-[14px]"
        />
        <input
          value={form.description}
          onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
          placeholder="Short description"
          className="rounded-lg border border-neutral-200 px-3 py-2 text-[13px]"
        />

        <div className="grid grid-cols-[36px_1fr_46px_64px_auto_20px] items-center gap-1.5 text-[10px] font-semibold tracking-wide text-neutral-300">
          <span />
          <span>EXERCISE</span>
          <span>SETS</span>
          <span>REPS</span>
          <span>COLOR</span>
          <span />
        </div>

        <div className="flex flex-col gap-1.5">
          {form.exercises.map((e, i) => (
            <div
              key={i}
              className="grid grid-cols-[36px_1fr_46px_64px_auto_20px] items-center gap-1.5 rounded-lg border border-neutral-100 p-1.5"
            >
              <input
                value={e.emoji}
                onChange={(ev) => updateExercise(i, { emoji: ev.target.value })}
                className="w-9 rounded border border-neutral-200 px-1 py-1 text-center text-[13px]"
                maxLength={2}
              />
              <input
                value={e.name}
                onChange={(ev) => {
                  const name = ev.target.value;
                  if (e.primaryMuscles.length === 0 && e.secondaryMuscles.length === 0) {
                    const { primary, secondary } = lookupMuscles(name);
                    updateExercise(i, { name, primaryMuscles: primary, secondaryMuscles: secondary });
                  } else {
                    updateExercise(i, { name });
                  }
                }}
                placeholder="Exercise name"
                className="min-w-0 rounded border border-neutral-200 px-2 py-1 text-[12px]"
              />
              <input
                type="number"
                min={1}
                max={20}
                value={e.targetSets}
                onChange={(ev) => updateExercise(i, { targetSets: Math.max(1, Number(ev.target.value) || 1) })}
                className="w-full rounded border border-neutral-200 px-1 py-1 text-[11px]"
              />
              <input
                value={e.targetReps}
                onChange={(ev) => updateExercise(i, { targetReps: ev.target.value })}
                placeholder="8-10"
                className="w-full rounded border border-neutral-200 px-1 py-1 text-[11px]"
              />
              <div className="flex gap-1">
                {COLORS.map((c) => (
                  <button
                    key={c}
                    onClick={() => updateExercise(i, { color: c })}
                    aria-label={c}
                    className={`h-4 w-4 rounded-full ${e.color === c ? 'ring-2 ring-neutral-400 ring-offset-1' : ''}`}
                    style={dotColor(c)}
                  />
                ))}
              </div>
              <button
                onClick={() => removeExercise(i)}
                aria-label="Remove exercise"
                className="px-1 text-[13px] text-neutral-400 hover:text-red-500"
              >
                ✕
              </button>

              <div className="col-span-6 flex items-center gap-2">
                <button
                  onClick={() => setExpanded(expanded === i ? null : i)}
                  className={`rounded px-1.5 py-[2px] text-[10.5px] font-medium ${
                    e.primaryMuscles.length === 0
                      ? 'bg-amber-50 text-amber-700 hover:bg-amber-100'
                      : 'bg-neutral-100 text-neutral-500 hover:bg-neutral-200'
                  }`}
                >
                  {e.primaryMuscles.length === 0
                    ? '⚠ no muscles tagged — won’t count toward volume'
                    : e.primaryMuscles.map((m) => MUSCLE_LABEL[m]).join(', ') +
                      (e.secondaryMuscles.length > 0
                        ? ` + ${e.secondaryMuscles.map((m) => MUSCLE_LABEL[m]).join(', ')} ½`
                        : '')}
                </button>
                <span className="text-[10px] text-neutral-300">{expanded === i ? '▲' : '▼'}</span>
              </div>

              {expanded === i && (
                <div className="col-span-6 rounded-lg bg-neutral-50 p-2">
                  <MusclePicker
                    primary={e.primaryMuscles}
                    secondary={e.secondaryMuscles}
                    onChange={(primary, secondary) =>
                      updateExercise(i, { primaryMuscles: primary, secondaryMuscles: secondary })
                    }
                  />
                </div>
              )}
            </div>
          ))}
        </div>

        <button
          onClick={addExercise}
          className="rounded-lg border border-dashed border-neutral-300 py-1.5 text-[12px] font-medium text-neutral-500 hover:bg-neutral-50"
        >
          + Add exercise
        </button>

        <div className="mt-2 flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="rounded-lg border border-neutral-200 px-3.5 py-1.5 text-[13px] font-medium text-neutral-600"
          >
            Cancel
          </button>
          <button
            onClick={() => form.name.trim() && onSave(form)}
            className="rounded-lg bg-violet-600 px-3.5 py-1.5 text-[13px] font-medium text-white hover:bg-violet-700"
          >
            Save split
          </button>
        </div>
      </div>
    </Modal>
  );
}
