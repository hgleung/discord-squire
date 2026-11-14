/**
 * One-time move of a JSON training log (the old PLAN_FILE) into the vault's
 * training folder. The JSON is only read, so it stays as a backup.
 * Run: npm run training:import -- <old-plan.json> <trainingDir>
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PlanStore } from './store.js';
import { TRAINING_NOTE } from './markdown.js';
import { parsePlanData } from '../../../lib/planFile.js';

const [jsonPath, dir] = process.argv.slice(2);
if (!jsonPath || !dir) {
  console.error('Usage: npm run training:import -- <old-plan.json> <trainingDir>');
  process.exit(1);
}

try {
  const plan = parsePlanData(readFileSync(jsonPath, 'utf8'));
  const store = new PlanStore(dir);
  if (store.exists()) {
    console.error(`${join(store.file, TRAINING_NOTE)} already exists, so this folder already holds a log. Not overwriting it.`);
    process.exit(1);
  }
  store.init(plan);

  const written = store.load();
  const days = Object.keys(written.days).length;
  // Days with no exercises have no file to live in.
  const empty = Object.keys(plan.days).length - days;
  console.log(
    `Wrote ${days} workout days, ${written.templates.length} splits and ${written.quickAddExercises.length} quick-add exercises to ${store.file}` +
      (empty > 0 ? ` (skipped ${empty} empty days).` : '.'),
  );
  console.log(`${jsonPath} is untouched.`);
} catch (err) {
  console.error(`Couldn't import ${jsonPath}: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}
