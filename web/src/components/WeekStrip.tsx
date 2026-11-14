import type { PlanData } from '../../../lib/types';
import { formatDayNumber, formatShortWeekday, toISODate } from '../../../lib/dateUtils';
import { getWeekDays } from '../../../lib/planOps';
import { computeTrainingStats } from '../../../lib/scoring';
import { ProgressRing } from './ProgressRing';

interface WeekStripProps {
  plan: PlanData;
  weekDates: Date[];
  selectedDate: string;
  onSelectDate: (date: string) => void;
}

export function WeekStrip({ plan, weekDates, selectedDate, onSelectDate }: WeekStripProps) {
  const days = getWeekDays(plan, selectedDate);
  const todayISO = toISODate(new Date());

  return (
    <div className="grid grid-cols-7 gap-3 border-b border-neutral-100 bg-white px-4 py-3">
      {weekDates.map((date, i) => {
        const dateISO = toISODate(date);
        const day = days[i];
        const stats = computeTrainingStats([day]);
        const isEmpty = day.exercises.length === 0;
        const percent = isEmpty ? null : stats.completionPercent;
        const isSelected = dateISO === selectedDate;
        const isToday = dateISO === todayISO;

        return (
          <button
            key={dateISO}
            onClick={() => onSelectDate(dateISO)}
            className={`flex flex-col items-center gap-2 rounded-xl border px-2 py-3 transition ${
              isSelected ? 'border-violet-300 bg-violet-50/60 shadow-sm' : 'border-neutral-100 hover:bg-neutral-50'
            }`}
          >
            <div className="text-center">
              <div className="text-[10px] font-semibold tracking-wide text-neutral-400">
                {formatShortWeekday(date)}
              </div>
              <div className={`text-[15px] font-semibold ${isToday ? 'text-violet-600' : 'text-neutral-800'}`}>
                {formatDayNumber(date)}
              </div>
            </div>
            <ProgressRing percent={percent} size={40} strokeWidth={4} active={isSelected} />
            <div className="text-[10px] text-neutral-400">
              {isEmpty ? 'rest' : `${stats.completedSetCount}/${stats.plannedSetCount} sets`}
            </div>
          </button>
        );
      })}
    </div>
  );
}
