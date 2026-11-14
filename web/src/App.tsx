import { useState } from 'react';
import { usePlan } from './hooks/usePlan';
import { datesInRange, getWeekDates, shiftDateISO, toISODate } from '../../lib/dateUtils';
import {
  addQuickAddToDay,
  addSet,
  applyTemplateToDay,
  applyTemplateToRange,
  deleteExercise,
  deleteTemplate,
  getOrEmptyDay,
  moveExercise,
  newBlankExercise,
  removeSet,
  updateSet,
  upsertExercise,
  upsertTemplate,
} from '../../lib/planOps';
import { previousBestE1RM } from '../../lib/scoring';
import type { Exercise, QuickAddExercise, WeightUnit, WorkoutTemplate } from '../../lib/types';
import { TopBar } from './components/TopBar';
import { WeekStrip } from './components/WeekStrip';
import { LeftSidebar } from './components/LeftSidebar';
import { ExerciseLogger } from './components/ExerciseLogger';
import { StatsPanel } from './components/StatsPanel';
import { ExerciseEditorModal } from './components/modals/ExerciseEditorModal';
import { TemplateManagerModal } from './components/modals/TemplateManagerModal';
import { BatchPlanModal } from './components/modals/BatchPlanModal';
import { PlanSetupModal } from './components/modals/PlanSetupModal';

export default function App() {
  const {
    plan,
    loading,
    saveStatus,
    error,
    dismissError,
    retry,
    updatePlan,
    startNewPlan,
    exportJSON,
    importJSON,
  } = usePlan();

  const [selectedDate, setSelectedDate] = useState(toISODate(new Date()));
  const [exerciseModal, setExerciseModal] = useState<{ exercise: Exercise; isNew: boolean } | null>(null);
  const [templateManagerOpen, setTemplateManagerOpen] = useState(false);
  const [batchPlanOpen, setBatchPlanOpen] = useState(false);
  const [planSettingsOpen, setPlanSettingsOpen] = useState(false);

  if (loading) {
    return <div className="flex h-screen items-center justify-center text-neutral-400">Loading…</div>;
  }

  if (!plan) {
    return <PlanSetupModal isFirstRun onSave={(planName, unit) => startNewPlan(planName, unit)} />;
  }

  const weekDates = getWeekDates(selectedDate);
  const dayLog = getOrEmptyDay(plan, selectedDate);
  const todayISO = toISODate(new Date());
  const unit = plan.config.unit;

  return (
    <div className="flex h-screen flex-col bg-neutral-50">
      {error && (
        <div className="flex items-center gap-3 border-b border-amber-100 bg-amber-50 px-4 py-2 text-[12.5px] text-amber-800">
          <span className="text-amber-700">{error}</span>
          {saveStatus === 'offline' && (
            <button onClick={() => void retry()} className="font-medium underline hover:text-amber-900">
              Retry
            </button>
          )}
          <button onClick={dismissError} className="ml-auto text-amber-400 hover:text-amber-700">
            ✕
          </button>
        </div>
      )}

      <TopBar
        plan={plan}
        selectedDate={selectedDate}
        onSelectDate={setSelectedDate}
        onToday={() => setSelectedDate(todayISO)}
        onShiftDay={(delta) => setSelectedDate((d) => shiftDateISO(d, delta))}
        saveStatus={saveStatus}
        onNewExercise={() => setExerciseModal({ exercise: newBlankExercise(), isNew: true })}
        onExportJSON={exportJSON}
        onImportJSON={importJSON}
        onManagePlan={() => setPlanSettingsOpen(true)}
      />

      <WeekStrip plan={plan} weekDates={weekDates} selectedDate={selectedDate} onSelectDate={setSelectedDate} />

      <div className="flex flex-1 overflow-hidden">
        <LeftSidebar
          plan={plan}
          selectedDayHasExercises={dayLog.exercises.length > 0}
          onQuickAdd={(item: QuickAddExercise) =>
            updatePlan((prev) => addQuickAddToDay(prev, selectedDate, item))
          }
          onApplyTemplate={(templateId) =>
            updatePlan((prev) => applyTemplateToDay(prev, selectedDate, templateId))
          }
          onManageTemplates={() => setTemplateManagerOpen(true)}
          onBatchPlan={() => setBatchPlanOpen(true)}
        />

        <ExerciseLogger
          day={dayLog}
          unit={unit}
          previousBests={Object.fromEntries(
            dayLog.exercises.map((e) => [
              e.name.trim().toLowerCase(),
              previousBestE1RM(plan.days, e.name, selectedDate),
            ]),
          )}
          onAddExercise={() => setExerciseModal({ exercise: newBlankExercise(), isNew: true })}
          onEditExercise={(exercise) => setExerciseModal({ exercise, isNew: false })}
          onDeleteExercise={(id) => updatePlan((prev) => deleteExercise(prev, selectedDate, id))}
          onMoveExercise={(id, delta) => updatePlan((prev) => moveExercise(prev, selectedDate, id, delta))}
          onUpdateSet={(exerciseId, setId, patch) =>
            updatePlan((prev) => updateSet(prev, selectedDate, exerciseId, setId, patch))
          }
          onAddSet={(exerciseId) => updatePlan((prev) => addSet(prev, selectedDate, exerciseId))}
          onRemoveSet={(exerciseId, setId) =>
            updatePlan((prev) => removeSet(prev, selectedDate, exerciseId, setId))
          }
        />

        <StatsPanel plan={plan} selectedDate={selectedDate} />
      </div>

      {exerciseModal && (
        <ExerciseEditorModal
          exercise={exerciseModal.exercise}
          isNew={exerciseModal.isNew}
          onClose={() => setExerciseModal(null)}
          onSave={(exercise) => {
            updatePlan((prev) => upsertExercise(prev, selectedDate, exercise));
            setExerciseModal(null);
          }}
          onDelete={() => {
            updatePlan((prev) => deleteExercise(prev, selectedDate, exerciseModal.exercise.id));
            setExerciseModal(null);
          }}
        />
      )}

      {templateManagerOpen && (
        <TemplateManagerModal
          templates={plan.templates}
          onClose={() => setTemplateManagerOpen(false)}
          onSave={(template: WorkoutTemplate) => updatePlan((prev) => upsertTemplate(prev, template))}
          onDelete={(templateId) => updatePlan((prev) => deleteTemplate(prev, templateId))}
        />
      )}

      {batchPlanOpen && (
        <BatchPlanModal
          templates={plan.templates}
          defaultStart={selectedDate}
          onClose={() => setBatchPlanOpen(false)}
          onApply={(start, end, templateId, skipWeekends) => {
            const dates = datesInRange(start, end, skipWeekends);
            updatePlan((prev) => applyTemplateToRange(prev, dates, templateId));
            setBatchPlanOpen(false);
          }}
        />
      )}

      {planSettingsOpen && (
        <PlanSetupModal
          isFirstRun={false}
          initial={{ planName: plan.config.planName, unit: plan.config.unit }}
          onClose={() => setPlanSettingsOpen(false)}
          onSave={(planName: string, nextUnit: WeightUnit) => {
            updatePlan((prev) => ({ ...prev, config: { ...prev.config, planName, unit: nextUnit } }));
            setPlanSettingsOpen(false);
          }}
        />
      )}
    </div>
  );
}
