import { useState } from 'react';
import type { WorkoutTemplate } from '../../../../lib/types';
import { Modal } from '../Modal';

interface BatchPlanModalProps {
  templates: WorkoutTemplate[];
  defaultStart: string;
  onApply: (startDate: string, endDate: string, templateId: string, skipWeekends: boolean) => void;
  onClose: () => void;
}

export function BatchPlanModal({ templates, defaultStart, onApply, onClose }: BatchPlanModalProps) {
  const [start, setStart] = useState(defaultStart);
  const [end, setEnd] = useState(defaultStart);
  const [templateId, setTemplateId] = useState(templates[0]?.id ?? '');
  const [skipWeekends, setSkipWeekends] = useState(false);

  return (
    <Modal title="Plan a date range" onClose={onClose}>
      <div className="flex flex-col gap-3">
        <div className="flex gap-2">
          <label className="flex-1 text-[12px] text-neutral-500">
            From
            <input
              type="date"
              value={start}
              onChange={(e) => setStart(e.target.value)}
              className="mt-1 w-full rounded-lg border border-neutral-200 px-2 py-1.5 text-[13px]"
            />
          </label>
          <label className="flex-1 text-[12px] text-neutral-500">
            To
            <input
              type="date"
              value={end}
              onChange={(e) => setEnd(e.target.value)}
              className="mt-1 w-full rounded-lg border border-neutral-200 px-2 py-1.5 text-[13px]"
            />
          </label>
        </div>

        <label className="text-[12px] text-neutral-500">
          Split
          <select
            value={templateId}
            onChange={(e) => setTemplateId(e.target.value)}
            className="mt-1 w-full rounded-lg border border-neutral-200 px-2 py-1.5 text-[13px]"
          >
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>

        <label className="flex items-center gap-2 text-[13px] text-neutral-600">
          <input type="checkbox" checked={skipWeekends} onChange={(e) => setSkipWeekends(e.target.checked)} />
          Skip Saturdays &amp; Sundays
        </label>

        <p className="text-[11.5px] text-neutral-400">
          This overwrites anything already logged on the days in this range.
        </p>

        <div className="mt-1 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-lg border border-neutral-200 px-3.5 py-1.5 text-[13px] font-medium text-neutral-600"
          >
            Cancel
          </button>
          <button
            onClick={() => templateId && start && end && onApply(start, end, templateId, skipWeekends)}
            className="rounded-lg bg-violet-600 px-3.5 py-1.5 text-[13px] font-medium text-white hover:bg-violet-700"
          >
            Apply to range
          </button>
        </div>
      </div>
    </Modal>
  );
}
