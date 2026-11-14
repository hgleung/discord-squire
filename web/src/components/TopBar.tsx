import { useState } from 'react';
import type { PlanData } from '../../../lib/types';
import { formatDayHeading, isToday } from '../../../lib/dateUtils';
import type { SaveStatus } from '../hooks/usePlan';

interface TopBarProps {
  plan: PlanData;
  selectedDate: string;
  onSelectDate: (date: string) => void;
  onToday: () => void;
  onShiftDay: (delta: number) => void;
  saveStatus: SaveStatus;
  onNewExercise: () => void;
  onExportJSON: () => void;
  onImportJSON: (file: File) => void;
  onManagePlan: () => void;
}

const STATUS_COPY: Record<SaveStatus, { label: string; dot: string }> = {
  saved: { label: 'Synced', dot: 'bg-emerald-500' },
  saving: { label: 'Saving…', dot: 'bg-amber-400' },
  unsaved: { label: 'Unsaved changes', dot: 'bg-amber-400' },
  error: { label: 'Save failed', dot: 'bg-red-500' },
  offline: { label: 'Server offline', dot: 'bg-red-500' },
};

export function TopBar({
  plan,
  selectedDate,
  onSelectDate,
  onToday,
  onShiftDay,
  saveStatus,
  onNewExercise,
  onExportJSON,
  onImportJSON,
  onManagePlan,
}: TopBarProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const status = STATUS_COPY[saveStatus];

  return (
    <div className="flex items-center gap-3 border-b border-neutral-100 bg-white px-4 py-3">
      <button
        onClick={() => onShiftDay(-1)}
        className="flex h-8 w-8 items-center justify-center rounded-lg border border-neutral-200 text-neutral-500 hover:bg-neutral-50"
      >
        ‹
      </button>
      <button
        onClick={onToday}
        className="rounded-lg border border-neutral-200 px-3 py-1.5 text-[13px] font-medium text-neutral-600 hover:bg-neutral-50"
      >
        Today
      </button>
      <button
        onClick={() => onShiftDay(1)}
        className="flex h-8 w-8 items-center justify-center rounded-lg border border-neutral-200 text-neutral-500 hover:bg-neutral-50"
      >
        ›
      </button>

      <div className="ml-1">
        <div className="flex items-center gap-2">
          <h1 className="text-[17px] font-semibold text-neutral-900">{formatDayHeading(selectedDate)}</h1>
          {isToday(selectedDate) && (
            <span className="rounded bg-violet-100 px-1.5 py-0.5 text-[10px] font-bold tracking-wide text-violet-600">
              TODAY
            </span>
          )}
        </div>
        <div className="text-[12px] text-neutral-400">{plan.config.planName}</div>
      </div>

      <div className="ml-auto flex items-center gap-2">
        <span
          title="The log is stored by the local server, shared with the Discord bot"
          className="flex items-center gap-1.5 rounded-lg border border-neutral-200 px-2.5 py-1.5 text-[12px] text-neutral-500"
        >
          <span className={`h-1.5 w-1.5 rounded-full ${status.dot}`} />
          {status.label}
        </span>

        <input
          type="date"
          value={selectedDate}
          onChange={(e) => e.target.value && onSelectDate(e.target.value)}
          className="rounded-lg border border-neutral-200 px-2 py-1.5 text-[13px] text-neutral-600"
        />

        <button
          onClick={onNewExercise}
          className="rounded-lg bg-violet-600 px-3.5 py-1.5 text-[13px] font-medium text-white hover:bg-violet-700"
        >
          + Add exercise
        </button>

        <div className="relative">
          <button
            onClick={() => setMenuOpen((v) => !v)}
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-neutral-200 text-neutral-500 hover:bg-neutral-50"
          >
            ⋯
          </button>
          {menuOpen && (
            <div
              className="absolute right-0 z-30 mt-1 w-56 rounded-xl border border-neutral-100 bg-white py-1 shadow-lg"
              onMouseLeave={() => setMenuOpen(false)}
            >
              <MenuItem onClick={onManagePlan}>Plan settings…</MenuItem>
              <MenuItem onClick={onExportJSON}>Export JSON</MenuItem>
              <MenuItem>
                <label className="block w-full cursor-pointer">
                  Import JSON…
                  <input
                    type="file"
                    accept="application/json"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) onImportJSON(file);
                      setMenuOpen(false);
                    }}
                  />
                </label>
              </MenuItem>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function MenuItem({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) {
  return (
    <button
      onClick={onClick}
      className="block w-full px-3 py-2 text-left text-[13px] text-neutral-600 hover:bg-neutral-50"
    >
      {children}
    </button>
  );
}
