import { useState } from 'react';
import type { WeightUnit } from '../../../../lib/types';
import { Modal } from '../Modal';

interface PlanSetupModalProps {
  isFirstRun: boolean;
  initial?: { planName: string; unit: WeightUnit };
  onSave: (planName: string, unit: WeightUnit) => void;
  onClose?: () => void;
}

export function PlanSetupModal({ isFirstRun, initial, onSave, onClose }: PlanSetupModalProps) {
  const [planName, setPlanName] = useState(initial?.planName ?? 'My training log');
  const [unit, setUnit] = useState<WeightUnit>(initial?.unit ?? 'lb');

  const body = (
    <div className="flex flex-col gap-3">
      {isFirstRun && (
        <p className="text-[13px] leading-relaxed text-neutral-500">
          A local-only training log. Everything you enter stays on this device — no account, no cloud. It runs
          indefinitely; there's no end date to set.
        </p>
      )}
      <label className="text-[12px] text-neutral-500">
        Log name
        <input
          value={planName}
          onChange={(e) => setPlanName(e.target.value)}
          className="mt-1 w-full rounded-lg border border-neutral-200 px-3 py-2 text-[14px]"
        />
      </label>

      <div>
        <div className="mb-1 text-[12px] text-neutral-500">Weight unit</div>
        <div className="flex gap-2">
          {(['lb', 'kg'] as WeightUnit[]).map((u) => (
            <button
              key={u}
              onClick={() => setUnit(u)}
              className={`flex-1 rounded-lg border py-1.5 text-[13px] font-medium ${
                unit === u
                  ? 'border-violet-400 bg-violet-50 text-violet-700'
                  : 'border-neutral-200 text-neutral-500'
              }`}
            >
              {u}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-1 flex justify-end gap-2">
        {!isFirstRun && onClose && (
          <button
            onClick={onClose}
            className="rounded-lg border border-neutral-200 px-3.5 py-1.5 text-[13px] font-medium text-neutral-600"
          >
            Cancel
          </button>
        )}
        <button
          onClick={() => planName.trim() && onSave(planName, unit)}
          className="rounded-lg bg-violet-600 px-3.5 py-1.5 text-[13px] font-medium text-white hover:bg-violet-700"
        >
          {isFirstRun ? 'Start logging' : 'Save'}
        </button>
      </div>
    </div>
  );

  if (isFirstRun) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-50 p-4">
        <div className="w-full max-w-[420px] rounded-2xl border border-neutral-100 bg-white p-6 shadow-xl">
          <h1 className="mb-1 text-[18px] font-bold text-neutral-900">Squire</h1>
          <p className="mb-4 text-[13px] text-neutral-400">A local-only training log.</p>
          {body}
        </div>
      </div>
    );
  }

  return (
    <Modal title="Log settings" onClose={onClose ?? (() => {})}>
      {body}
    </Modal>
  );
}
