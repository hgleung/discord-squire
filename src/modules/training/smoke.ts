/**
 * Exercises the bot's logic against a real training folder without Discord.
 * Run: npx tsx src/modules/training/smoke.ts
 */
import { existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlanStore } from './store.js';
import { parsePlan, renderPlan } from './markdown.js';
import { formatSession, formatSplits, formatLogged } from './format.js';
import { createNewPlan } from '../../../lib/defaults.js';
import { applyTemplateToDay, getOrEmptyDay, updateSet } from '../../../lib/planOps.js';
import { InvalidPlanFileError } from '../../../lib/planFile.js';
import { bestE1RM, completedSets, plannedSets, previousBestE1RM } from '../../../lib/scoring.js';
import type { PlanData } from '../../../lib/types.js';

let failures = 0;
const check = (label: string, ok: boolean, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${label} ${ok ? 'OK' : `FAIL${detail ? ` (${detail})` : ''}`}`);
};

/** Plans compared the way the markdown keeps them: ids are positional, and key order is irrelevant. */
const canon = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canon)
    : typeof value === 'object' && value !== null
      ? Object.fromEntries(Object.entries(value).filter(([k]) => k !== 'id').sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canon(v)]))
      : value;

const today = new Date().toISOString().slice(0, 10);
const dir = mkdtempSync(join(tmpdir(), 'squire-bot-'));
const dayFile = join(dir, 'Workouts', `${today} Workout.md`);

// 1. A fresh folder gets a log, the way the web app's first run makes one.
const store = new PlanStore(dir);
check('0. empty folder .........', !store.exists());
store.init(createNewPlan('Smoke test log', 'lb', today));
check('1. init + load ...........', store.load().config.planName === 'Smoke test log' && existsSync(join(dir, 'Splits', 'Push day.md')));

// 2. /splits
const splits = formatSplits(store.load());
check('2. /splits ...............', splits.includes('Push day'));

// 3. /today on an empty day
const empty = formatSession(store.load(), getOrEmptyDay(store.load(), today), today);
check('3. /today (empty) ........', empty.includes('nothing planned'));

// 4. /split push
const pushId = store.load().templates.find((t) => t.name === 'Push day')!.id;
store.update((p) => applyTemplateToDay(p, today, pushId));
const loaded = getOrEmptyDay(store.load(), today);
check('4. /split Push day .......', loaded.exercises.length === 6 && loaded.templateId === pushId, `${loaded.exercises.length} exercises`);
check('4. day note links split ..', readFileSync(dayFile, 'utf8').includes('split: "[[Push day]]"'));

// 5. /today after loading a split
const session = formatSession(store.load(), loaded, today);
check('5. /today (loaded) .......', session.includes('Barbell bench press') && session.includes('⬜'));

// 6. /log — fills the first incomplete set
const bench = loaded.exercises[0];
const firstSet = bench.sets.find((s) => !s.completed)!;
const prev = previousBestE1RM(store.load().days, bench.name, today);
const after = store.update((p) => updateSet(p, today, bench.id, firstSet.id, { weight: 135, reps: 6, completed: true }));
const benchAfter = getOrEmptyDay(after, today).exercises.find((e) => e.id === bench.id)!;
const e1rm = bestE1RM(benchAfter);
check('6. /log 135x6 ............', completedSets(benchAfter) === 1 && Math.round(e1rm!) === 162, `${completedSets(benchAfter)} sets, e1RM ${e1rm}`);

// 7. Reply text, including PR detection against no history
const reply = formatLogged(benchAfter.name, 135, 6, 'lb', completedSets(benchAfter), plannedSets(benchAfter), e1rm, prev === null || e1rm! > prev);
check('7. /log reply ............', reply.includes('set 1 of 4') && reply.includes('🏆'), reply);

// 8. Persistence round-trip — a fresh store sees the write
check('8. fresh store ...........', completedSets(getOrEmptyDay(new PlanStore(dir).load(), today).exercises[0]) === 1);

// 9. Markdown round trip: sets, a null weight, a note, secondary muscles, kg.
const rich: PlanData = createNewPlan('Round trip', 'kg', '2026-01-05');
rich.days['2026-11-12'] = {
  date: '2026-11-12',
  templateId: 'tpl-pull-day',
  exercises: [
    {
      id: 'a', name: 'Barbell row', emoji: '💪', color: 'teal', targetSets: 3, targetReps: '8-10',
      primaryMuscles: ['upperBack', 'lats'], secondaryMuscles: ['biceps', 'rearDelts'],
      sets: [
        { id: 's1', weight: 80.5, reps: 8, completed: true },
        { id: 's2', weight: null, reps: 10, completed: true },
        { id: 's3', weight: null, reps: null, completed: false },
      ],
      note: 'Grip felt weak.\n\nTry straps next time.',
    },
    { id: 'b', name: 'Plank', emoji: '', color: 'green', targetSets: 2, targetReps: '', primaryMuscles: [], secondaryMuscles: [], sets: [] },
  ],
};
const files = renderPlan(rich);
const reparsed = parsePlan(files).plan;
check('9. markdown round trip ...', JSON.stringify(canon(reparsed)) === JSON.stringify(canon(rich)));
const rerendered = renderPlan(reparsed);
check('9. second render stable ..', [...files].every(([rel, text]) => rerendered.get(rel) === text) && rerendered.size === files.size);
check('9. set lines .............', files.get('Workouts/2026-11-12 Workout.md')!.includes('- [x] 80.5 kg × 8\n- [x] — × 10\n- [ ] — × —'));

// 10. Ticking a checkbox in Obsidian counts as a completed set, at a new revision.
const revBefore = store.rev;
let emitted = 0;
const onChange = () => (emitted += 1);
store.on('change', onChange);
writeFileSync(dayFile, readFileSync(dayFile, 'utf8').replace('- [ ]', '- [x]'));
// Same size, so make sure the mtime moves even if this lands in the same tick as the store's own write.
utimesSync(dayFile, new Date(), new Date(Date.now() + 2000));
const ticked = getOrEmptyDay(store.load(), today).exercises[0];
check('10. checkbox ticked ......', completedSets(ticked) === 2 && store.rev === revBefore + 1 && emitted === 1, `${completedSets(ticked)} sets, rev ${store.rev}`);
store.off('change', onChange);

// 11. An exercise heading added by hand becomes an exercise.
writeFileSync(dayFile, `${readFileSync(dayFile, 'utf8')}\n## Face pull\n\n- [x] 30 lb × 15\n- [x] bw x 12\nFelt it in the rear delts.\n`);
const handAdded = getOrEmptyDay(store.load(), today).exercises.at(-1)!;
check(
  '11. hand-added exercise ..',
  handAdded.name === 'Face pull' && handAdded.targetSets === 2 && completedSets(handAdded) === 2 &&
    handAdded.sets[1].weight === null && handAdded.primaryMuscles[0] === 'rearDelts' && handAdded.note === 'Felt it in the rear delts.',
  JSON.stringify(handAdded),
);

// 12. Renaming a split removes the old note and keeps the day linked.
store.update((p) => ({ ...p, templates: p.templates.map((t) => (t.id === pushId ? { ...t, name: 'Chest day' } : t)) }));
check(
  '12. split rename .........',
  !existsSync(join(dir, 'Splits', 'Push day.md')) && existsSync(join(dir, 'Splits', 'Chest day.md')) &&
    readFileSync(dayFile, 'utf8').includes('[[Chest day]]') && getOrEmptyDay(store.load(), today).templateId === pushId,
);

// 13. An invalid plan is rejected before anything is written.
let rejected = false;
try {
  store.save({ ...store.load(), days: { '../escape': { date: 'x', exercises: [] } } });
} catch (err) {
  rejected = err instanceof InvalidPlanFileError;
}
check('13. invalid plan rejected ', rejected && !existsSync(join(dir, 'escape Workout.md')));

// 14. A mangled note is read as best it can be; the rest of the log still loads.
writeFileSync(join(dir, 'Workouts', '2020-01-01 Workout.md'), '---\nsplit: [[unclosed\n---\n## \u{1F9F1} Core circuit\nnot a set line\n');
const old = new PlanStore(dir).load().days['2020-01-01'];
check('14. mangled note .........', old?.exercises[0].name === 'Core circuit' && old.exercises[0].note === 'not a set line');

// 15. The watcher reports an Obsidian edit without anyone asking.
const watched = new PlanStore(dir);
watched.load();
const live = await new Promise<boolean>((done) => {
  const timer = setTimeout(() => done(false), 3000);
  watched.once('change', () => {
    clearTimeout(timer);
    done(true);
  });
  writeFileSync(dayFile, readFileSync(dayFile, 'utf8').replace('Felt it', 'Really felt it'));
});
check('15. live outside edit ....', live);

console.log(`\nTemp training folder: ${dir}`);
console.log(failures === 0 ? 'all checks passed' : `${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
