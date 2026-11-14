import type { PlanData, QuickAddExercise } from '../../../lib/types';
import { dotColor } from '../lib/colors';

interface LeftSidebarProps {
  plan: PlanData;
  selectedDayHasExercises: boolean;
  onQuickAdd: (item: QuickAddExercise) => void;
  onApplyTemplate: (templateId: string) => void;
  onManageTemplates: () => void;
  onBatchPlan: () => void;
}

export function LeftSidebar({
  plan,
  selectedDayHasExercises,
  onQuickAdd,
  onApplyTemplate,
  onManageTemplates,
  onBatchPlan,
}: LeftSidebarProps) {
  return (
    <div className="flex w-[280px] shrink-0 flex-col gap-4 overflow-y-auto border-r border-neutral-100 bg-white p-4">
      <div className="flex flex-col gap-1.5">
        {plan.quickAddExercises.map((item) => (
          <div
            key={item.id}
            className="flex items-center gap-2.5 rounded-lg px-1.5 py-1.5 hover:bg-neutral-50"
          >
            <span className="text-[16px]">{item.emoji}</span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-medium text-neutral-700">{item.name}</div>
              <div className="text-[11px] text-neutral-400">
                {item.targetSets}×{item.targetReps}
              </div>
            </div>
            <button
              onClick={() => onQuickAdd(item)}
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-neutral-200 text-neutral-400 hover:bg-violet-50 hover:text-violet-600"
              title="Add to selected day"
            >
              +
            </button>
          </div>
        ))}
      </div>

      <div className="border-t border-neutral-100 pt-4">
        <div className="mb-0.5 flex items-center justify-between">
          <span className="text-[11px] font-bold tracking-wide text-neutral-400">SPLITS</span>
          <button onClick={onManageTemplates} className="text-[12px] font-medium text-violet-600 hover:underline">
            Manage
          </button>
        </div>
        <p className="mb-2 text-[11px] text-neutral-400">
          Loads the whole session, pre-filled with your last weights.
        </p>

        <div className="flex flex-col gap-2">
          {plan.templates.map((template) => (
            <button
              key={template.id}
              onClick={() => {
                if (
                  selectedDayHasExercises &&
                  !window.confirm(
                    `Replace this day's logged exercises with "${template.name}"? Any sets you've recorded will be lost.`,
                  )
                ) {
                  return;
                }
                onApplyTemplate(template.id);
              }}
              className="rounded-xl border border-neutral-100 p-2.5 text-left hover:border-violet-200 hover:bg-violet-50/40"
            >
              <div className="flex items-center justify-between">
                <span className="text-[13px] font-semibold text-neutral-800">{template.name}</span>
                <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] font-medium text-neutral-500">
                  {template.exercises.length} exercises
                </span>
              </div>
              <p className="mt-0.5 text-[11px] text-neutral-400">{template.description}</p>
              <div className="mt-1.5 flex flex-wrap gap-1">
                {template.exercises.map((e, i) => (
                  <span key={i} className="h-1.5 w-1.5 rounded-full" style={dotColor(e.color)} />
                ))}
              </div>
            </button>
          ))}
        </div>

        <button
          onClick={onBatchPlan}
          className="mt-3 w-full rounded-lg border border-neutral-200 py-2 text-[13px] font-medium text-neutral-600 hover:bg-neutral-50"
        >
          ✨ Plan a date range
        </button>
      </div>
    </div>
  );
}
