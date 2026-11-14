import type { PlanData } from '../../../lib/types';
import { parsePlanData } from '../../../lib/planFile';

// Plan-file parsing, validation, and migration live in ./planFile so the
// server can reuse them without pulling in browser APIs.
export { InvalidPlanFileError, parsePlanData } from '../../../lib/planFile';

/**
 * The local server owns the plan (see ./api). These two remain as the manual
 * escape hatch: take a copy out, or bring one in from another machine.
 */

export function downloadJSON(data: PlanData, filename: string): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function readJSONFile(file: File): Promise<PlanData> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        resolve(parsePlanData(reader.result as string));
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}
