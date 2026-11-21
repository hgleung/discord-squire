import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { RECIPES_FOLDER, Vault } from '../../vault.js';
import { FACTORY_FOLDER, JOBS_FOLDER, jobPrompt, jobSettings, PROMPTS_FOLDER } from './factory.js';
import type { LLM, ModelOptions, ToolDef, Turn, Usage } from './llm.js';
import { pageKey, ReadLog } from './readLog.js';
import { ReminderStore } from './reminders.js';
import { TaskRunner, TaskStore, type Task } from './tasks.js';
import { noteBody, noteFields } from './taskNotes.js';
import { addUsage, costUsd } from './usage.js';
import { toLocalIso } from './time.js';

/**
 * Evals for a factory job: cases built from real past runs, each with a
 * checklist, run against a prompt and scored. Cases live in
 * Factory/Evals/<job>/<case>.md, results in Factory/Evals/<job>/results/.
 *
 * Every case runs in a sandbox: a copy of Recipes/ and Factory/Prompts/ in a
 * temp folder, so the job sees the real subfolders but writes nothing to the
 * vault. Only the results note is written to the real vault.
 *
 * Checklist items are judged by code where they can be (sources, folder) and
 * by the cheap model where they need reading (estimates, units, amounts).
 */

export const EVALS_FOLDER = `${FACTORY_FOLDER}/Evals`;

export const CHECKS = ['sources_linked', 'estimates_labeled', 'units_consistent', 'right_folder', 'no_invented_amounts'] as const;
export type CheckName = (typeof CHECKS)[number];
const CODE_CHECKS: CheckName[] = ['sources_linked', 'right_folder'];
const MODEL_CHECKS: CheckName[] = ['estimates_labeled', 'units_consistent', 'no_invented_amounts'];

export const CHECK_LABELS: Record<CheckName, string> = {
  sources_linked: 'Sources linked',
  estimates_labeled: 'Estimates labeled',
  units_consistent: 'Units consistent',
  right_folder: 'Right folder',
  no_invented_amounts: 'No invented amounts',
};

export interface EvalCase {
  path: string;
  name: string;
  /** The link, or the text the owner sent. */
  input: string;
  /** Anything else the owner said with it ("cut it in half"). */
  ask: string;
  /** Where the note belongs, e.g. Recipes/Soup. */
  folder: string;
  checks: CheckName[];
  /** Free-text items that must be true of the result, judged by the model: any job's checklist. */
  checklist: string[];
  /** The case note's frontmatter, for job-specific fields (expected events, the day). */
  fields: Record<string, unknown>;
}

export interface Verdict {
  pass: boolean;
  why: string;
}

export interface CaseResult {
  case: EvalCase;
  /** The note the job saved in the sandbox, if any. */
  output?: string;
  note?: string;
  report: string;
  status: Task['status'] | 'error';
  /** By check name, or by checklist item text. */
  verdicts: Record<string, Verdict>;
  pass: boolean;
  usage?: Usage;
}

/** The cases for a job, from Factory/Evals/<job>/ (not results/). */
export function loadCases(vault: Vault, job: string): EvalCase[] {
  const folder = jobSettings(vault, job).evals;
  return vault
    .list(folder)
    .filter((p) => !p.startsWith(`${folder}/results/`))
    .map((path) => {
      const f = noteFields(vault.read(path) ?? '');
      const checklist = Array.isArray(f.checklist) ? f.checklist.map(String).filter(Boolean) : [];
      // Named checks are the recipe job's; a case with only a checklist has none unless it names them.
      const checks = (Array.isArray(f.checks) ? f.checks.map(String) : checklist.length || job !== 'recipe' ? [] : [...CHECKS]).filter((c): c is CheckName => (CHECKS as readonly string[]).includes(c));
      return {
        path,
        name: path.split('/').at(-1)!.replace(/\.md$/, ''),
        input: String(f.input ?? '').trim(),
        ask: String(f.ask ?? '').trim(),
        folder: String(f.folder ?? '').trim().replace(/\/+$/, ''),
        checks,
        checklist,
        fields: f,
      };
    })
    .filter((c) => c.input);
}

const URL_RE = /https?:\/\/[^\s)<>\]]+/g;

/** The checklist items code can settle: sources linked and the right folder. */
export function codeChecks(c: Pick<EvalCase, 'checks' | 'input' | 'folder'>, output: string | undefined, note: string | undefined): Record<string, Verdict> {
  const out: Record<string, Verdict> = {};
  if (!output || note === undefined) {
    for (const k of c.checks.filter((k) => CODE_CHECKS.includes(k))) out[k] = { pass: false, why: 'no recipe note was saved' };
    return out;
  }
  if (c.checks.includes('sources_linked')) {
    const links = note.match(URL_RE) ?? [];
    const isLink = /^https?:\/\//.test(c.input);
    const hasInput = !isLink || links.some((l) => pageKey(l) === pageKey(c.input));
    const hasSection = /^#{1,3}\s*Sources?\b/im.test(note) || /^\**Source:?\**/im.test(noteBody(note).trim());
    out.sources_linked =
      links.length === 0 && !/from the owner/i.test(note)
        ? { pass: false, why: 'no source links in the note' }
        : !hasInput
          ? { pass: false, why: `the link it was given (${c.input}) isn't in the note` }
          : !hasSection
            ? { pass: false, why: 'no Source line or Sources section' }
            : { pass: true, why: `${links.length} link(s), the input among them` };
  }
  if (c.checks.includes('right_folder')) {
    const folder = output.split('/').slice(0, -1).join('/');
    out.right_folder = folder.toLowerCase() === c.folder.toLowerCase() ? { pass: true, why: folder } : { pass: false, why: `filed in ${folder}, belongs in ${c.folder}` };
  }
  return out;
}

export const JUDGE_TOOL: ToolDef = {
  name: 'verdict',
  description: 'Give the verdict on each checklist item.',
  strict: true,
  input_schema: {
    type: 'object',
    properties: Object.fromEntries(
      MODEL_CHECKS.map((k) => [
        k,
        { type: 'object', properties: { pass: { type: 'boolean' }, why: { type: 'string' } }, required: ['pass', 'why'], additionalProperties: false },
      ]),
    ),
    required: [...MODEL_CHECKS],
    additionalProperties: false,
  },
};

export const JUDGE_SYSTEM = `You grade one recipe note that an assistant wrote from a source (a video's caption and transcript, or a recipe page). You get the owner's request, what the assistant read from the source, the note, and its report. Judge only these items, strictly, and call verdict once:
- estimates_labeled: every amount, time or serving count that is the assistant's own suggestion rather than the source's is labeled as an estimate (e.g. "(estimate)") in the note itself. Amounts scaled by arithmetic from the source's amounts are not estimates, and neither is rounding a scaled amount to a kitchen measure (1⅔ cloves → 2, ⅔ tsp → a scant ¾ tsp, a range like 6 to 8 → 2 to 3). Pass if there are no estimates. Fail if the report or note says something is estimated or recommended without labeling it in the note.
- units_consistent: the note uses one consistent system for each kind of measure, the source's own units unless asked otherwise; paired conversions like "75 g (½ cup)" are fine. Fail for mixed systems with no pairing, or a unit that's wrong for the ingredient.
- no_invented_amounts: every amount and time in the note is in the source material, scaled correctly from it (rounded to a kitchen measure is fine), or labeled as an estimate or "not given". Fail for any unlabeled amount you can't find in the source material. If the source material shown is cut off or missing, judge only on what you can see and say so.
Keep each "why" to one sentence naming the specific line.`;

/** The judge's request: what the owner asked, what the job read, the note and its report. */
export function judgeTurns(c: EvalCase, evidence: string, note: string, report: string): Turn[] {
  const text =
    `Owner's request: ${c.input}${c.ask ? `\n${c.ask}` : ''}\n\n` +
    `What the assistant read from the source:\n<source>\n${evidence.slice(0, 40_000) || '(nothing captured)'}\n</source>\n\n` +
    `The note it saved:\n<note>\n${note.slice(0, 20_000)}\n</note>\n\n` +
    `Its report:\n<report>\n${report.slice(0, 4_000)}\n</report>`;
  return [{ role: 'user', content: [{ type: 'text', text }] }];
}

/** The tool results the job got back (video transcripts, fetched pages): the judge's view of the source. */
export function evidenceFrom(turns: Turn[]): string {
  return turns
    .flatMap((t) => (t.role === 'tool' ? t.results : []))
    .filter((r) => !r.isError && ['watch_video', 'fetch_page'].includes(r.name))
    .map((r) => `[${r.name}]\n${r.content}`)
    .join('\n\n');
}

/** Rough cost per case, from list prices: a job run on the task model plus one judge call on the fast model. */
export function estimateCost(cases: number, taskModel: string, judgeModel: string): number {
  const run: Usage = { model: taskModel, input: 160_000, output: 10_000, cacheRead: 60_000, cacheWrite: 20_000, webSearches: 1, webFetches: 2 };
  const judge: Usage = { model: judgeModel, input: 15_000, output: 600, cacheRead: 0, cacheWrite: 0, webSearches: 0, webFetches: 0 };
  return cases * (costUsd(run) + costUsd(judge));
}

const mark = (v?: Verdict) => (v === undefined ? '—' : v.pass ? '✅' : '❌');

/** The results note: a pass/fail table, then each case's reasons and the note it wrote. */
export function resultsNote(job: string, prompt: string, results: CaseResult[], when: Date, timeZone: string, cost: number): string {
  const passed = results.filter((r) => r.pass).length;
  const failedItems: Record<string, number> = {};
  for (const r of results) for (const [k, v] of Object.entries(r.verdicts)) if (!v.pass) failedItems[k.slice(0, 80)] = (failedItems[k.slice(0, 80)] ?? 0) + 1;
  const fields = {
    job,
    prompt,
    date: toLocalIso(when, timeZone),
    passed,
    total: results.length,
    pass_rate: results.length ? Math.round((passed / results.length) * 100) / 100 : 0,
    failed_items: failedItems,
    cost_usd: Math.round(cost * 100) / 100,
    tags: ['squire-eval'],
  };
  // Columns: the named checks any case uses, then numbered checklist items (their text is under each case).
  const named = CHECKS.filter((k) => results.some((r) => r.case.checks.includes(k)));
  const width = Math.max(0, ...results.map((r) => r.case.checklist.length));
  const extra = [...new Set(results.flatMap((r) => Object.keys(r.verdicts).filter((k) => !(CHECKS as readonly string[]).includes(k) && !r.case.checklist.includes(k))))];
  const cols = [...named.map((k) => CHECK_LABELS[k]), ...extra, ...Array.from({ length: width }, (_, n) => `#${n + 1}`)];
  const head = `| Case | ${cols.join(' | ')} | Pass |\n|---|${cols.map(() => '---').join('|')}|---|`;
  const rows = results.map((r) => `| ${r.case.name} | ${[...named.map((k) => mark(r.verdicts[k])), ...extra.map((k) => mark(r.verdicts[k])), ...Array.from({ length: width }, (_, n) => mark(r.case.checklist[n] ? r.verdicts[r.case.checklist[n]!] : undefined))].join(' | ')} | ${r.pass ? '**pass**' : 'fail'} |`);
  const details = results.map((r) => {
    const why = Object.entries(r.verdicts)
      .map(([k, v]) => `- ${mark(v)} ${CHECK_LABELS[k as CheckName] ?? k}: ${v.why}`)
      .join('\n');
    const note = r.note
      ? `\n\n> [!note]- ${r.output}\n${r.note.split('\n').map((l) => `> ${l}`).join('\n')}`
      : r.report
        ? `\n\n> [!quote]- Report\n${r.report.split('\n').map((l) => `> ${l}`).join('\n')}`
        : '';
    return `### ${r.case.name}\n\nInput: ${r.case.input}${r.case.ask ? ` (${r.case.ask})` : ''} · task ${r.status} · saved ${r.output ?? 'nothing'}\n\n${why}${note}`;
  });
  return `---\n${stringify(fields).trimEnd()}\n---\n\n# ${job} eval, ${toLocalIso(when, timeZone).slice(0, 10)}\n\nPrompt **${prompt}**: ${passed}/${results.length} cases passed.\n\n${head}\n${rows.join('\n')}\n\n## Cases\n\n${details.join('\n\n')}\n`;
}

/** A results path that doesn't overwrite an earlier run the same day. */
export function resultsPath(vault: Vault, job: string, when: Date, timeZone: string): string {
  const base = `${jobSettings(vault, job).evals}/results/${toLocalIso(when, timeZone).slice(0, 10)}`;
  let rel = `${base}.md`;
  for (let i = 2; vault.read(rel) !== undefined; i++) rel = `${base} ${i}.md`;
  return rel;
}

/** A copy of the parts of the vault a job reads (Recipes, its write paths, the prompts and job notes), in a temp folder. */
export function sandbox(vault: Vault, extra: string[] = []): Vault {
  const dir = mkdtempSync(join(tmpdir(), 'squire-eval-'));
  for (const folder of [...new Set([RECIPES_FOLDER, PROMPTS_FOLDER, JOBS_FOLDER, ...extra])]) {
    const src = vault.abs(folder);
    if (existsSync(src)) cpSync(src, join(dir, folder), { recursive: true, filter: (p) => !p.split(/[\\/]/).at(-1)!.startsWith('.') });
  }
  return new Vault(dir);
}

export interface RunOptions {
  vault: Vault;
  llm: LLM;
  taskModel: string;
  judge: ModelOptions;
  timeZone: string;
  job: string;
  prompt?: string;
  /** Called as each case finishes. */
  onCase?: (r: CaseResult, i: number, n: number) => void;
}

/** What one case's run produced, for judging. */
export interface CaseRun {
  /** Where the result went (a note path), if anywhere. */
  output?: string;
  /** The result itself: the note, the brief, the events found. */
  note?: string;
  report: string;
  status: CaseResult['status'];
  /** What the job read, for the judge. */
  evidence: string;
  usage?: Usage;
  /** Checklist items the runner's own code already judged. */
  verdicts?: Record<string, Verdict>;
}

/** Runs one case of a job with a given prompt, in a sandbox. Code-run jobs (the brief, inbox events) register their own. */
export type CaseRunner = (c: EvalCase, o: RunOptions, llm: LLM) => Promise<CaseRun>;
export const CASE_RUNNERS: Record<string, CaseRunner> = {};

/** A task job's case: a real job task in a sandbox copy of the vault. */
async function runTaskCase(c: EvalCase, o: RunOptions, base: LLM): Promise<CaseRun> {
  // The job sees the folders it writes to, as they are, but writes only to the copy.
  const box = sandbox(o.vault, jobSettings(o.vault, o.job).writePaths);
  // The note the case was built from is the answer; without this the job finds it and saves nothing.
  const from = /^\[\[([^\]|#]+)/.exec(String(c.fields.from ?? ''))?.[1]?.trim();
  if (from) rmSync(box.abs(`${box.notePath(from)}.md`), { force: true });
  let lastTurns: Turn[] = [];
  const llm: LLM = {
    retryable: (err) => base.retryable(err),
    generate: async (m, req) => {
      lastTurns = req.turns;
      return base.generate(m, req);
    },
  };
  try {
    const settings = jobSettings(o.vault, o.job);
    const runner = new TaskRunner(new TaskStore(join(box.root, '.eval', 'tasks.json')), {
      llm,
      model: o.taskModel,
      fastModel: o.judge.model,
      effort: 'medium',
      timeZone: o.timeZone,
      reminders: new ReminderStore(join(box.root, '.eval', 'reminders.json'), o.timeZone),
      vault: box,
      reads: new ReadLog(),
    });
    const task = runner.start({
      title: `Eval ${c.name}`,
      goal: `${c.input}${c.ask ? `\n${c.ask}` : ''}`,
      doneWhen: o.job === 'recipe' ? 'a sourced recipe note for it is saved, or the report says why not' : 'the job is done, or the report says why not',
      deadline: new Date(Date.now() + 3600_000),
      channelId: 'eval',
      channelName: settings.channel,
      job: o.job,
      prompt: o.prompt,
    });
    while (['queued', 'running', 'waiting'].includes(runner.list().find((t) => t.id === task.id)!.status)) {
      // A wait_until in an eval is skipped: run it now.
      await Promise.all(runner.tick(new Date(Date.now() + 86_400_000)));
      await new Promise((r) => setTimeout(r, 200));
    }
    const done = runner.list().find((t) => t.id === task.id)!;
    // In shadow mode the job proposes its note instead of saving it: judge the proposal.
    return {
      output: done.output ?? done.proposal?.path,
      note: done.output ? box.read(done.output) : (done.proposal?.content ?? (o.job === 'recipe' ? undefined : done.result)),
      report: done.result ?? '',
      status: done.status,
      evidence: evidenceFrom(lastTurns),
      usage: done.usage,
    };
  } finally {
    rmSync(box.root, { recursive: true, force: true });
  }
}

const CHECKLIST_SYSTEM = `You grade one result of an assistant's job against a checklist. You get the input it was given, what it read, the result and its report. Judge each checklist item strictly, in order, and call verdict once with one entry per item. Keep each "why" to one sentence naming the specific line.`;

const checklistTool = (n: number): ToolDef => ({
  name: 'verdict',
  description: 'Give the verdict on each checklist item, in order.',
  strict: true,
  input_schema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        description: `Exactly ${n} entries, one per checklist item, in order.`,
        items: { type: 'object', properties: { pass: { type: 'boolean' }, why: { type: 'string' } }, required: ['pass', 'why'], additionalProperties: false },
      },
    },
    required: ['items'],
    additionalProperties: false,
  },
});

/** Runs every case of a job in its own sandbox and judges it. Writes nothing to the real vault. */
export async function runEvals(o: RunOptions): Promise<{ prompt: string; results: CaseResult[]; cost: number }> {
  const cases = loadCases(o.vault, o.job);
  const prompt = jobPrompt(o.vault, o.job, o.prompt).name;
  const results: CaseResult[] = [];
  let total: Usage | undefined;
  const counted: LLM = {
    retryable: (err) => o.llm.retryable(err),
    generate: async (m, req) => {
      const gen = await o.llm.generate(m, req);
      if (gen.usage) total = total ? addUsage(total, gen.usage) : gen.usage;
      return gen;
    },
  };
  const runCase = CASE_RUNNERS[o.job] ?? runTaskCase;
  for (const [i, c] of cases.entries()) {
    let result: CaseResult;
    try {
      const run = await runCase(c, o, counted);
      const verdicts: Record<string, Verdict> = { ...codeChecks(c, run.output, run.note), ...run.verdicts };
      const wanted = c.checks.filter((k) => MODEL_CHECKS.includes(k));
      const missing = { pass: false, why: 'nothing was produced' };
      if (wanted.length) {
        if (!run.note) {
          for (const k of wanted) verdicts[k] = missing;
        } else {
          const gen = await counted.generate(o.judge, { system: JUDGE_SYSTEM, tools: [JUDGE_TOOL], turns: judgeTurns(c, run.evidence, run.note, run.report), web: { maxUses: 0 } });
          const v = gen.calls.find((call) => call.name === 'verdict')?.input as Record<string, Verdict> | undefined;
          for (const k of wanted) verdicts[k] = v?.[k] && typeof v[k].pass === 'boolean' ? { pass: v[k].pass, why: String(v[k].why ?? '') } : { pass: false, why: 'the judge gave no verdict' };
        }
      }
      if (c.checklist.length) {
        if (!run.note) {
          for (const item of c.checklist) verdicts[item] = missing;
        } else {
          const turns = judgeTurns(c, run.evidence, run.note, run.report);
          const first = turns[0]!;
          if (first.role === 'user') first.content.push({ type: 'text', text: `Checklist:\n${c.checklist.map((x, n) => `${n + 1}. ${x}`).join('\n')}` });
          const gen = await counted.generate(o.judge, { system: CHECKLIST_SYSTEM, tools: [checklistTool(c.checklist.length)], turns, web: { maxUses: 0 } });
          const items = (gen.calls.find((call) => call.name === 'verdict')?.input as { items?: Verdict[] } | undefined)?.items ?? [];
          c.checklist.forEach((item, n) => {
            const v = items[n];
            verdicts[item] = v && typeof v.pass === 'boolean' ? { pass: v.pass, why: String(v.why ?? '') } : { pass: false, why: 'the judge gave no verdict' };
          });
        }
      }
      result = { case: c, output: run.output, note: run.note, report: run.report, status: run.status, verdicts, pass: Object.keys(verdicts).length > 0 && [...c.checks, ...c.checklist].every((k) => verdicts[k]?.pass) && Object.values(verdicts).every((v) => v.pass), usage: run.usage };
    } catch (err) {
      result = { case: c, report: err instanceof Error ? err.message : String(err), status: 'error', verdicts: {}, pass: false };
    }
    results.push(result);
    o.onCase?.(result, i, cases.length);
  }
  return { prompt, results, cost: total ? costUsd(total) : 0 };
}

/** The recipe cases, from real runs in #recipes. Written once if the folder has none; never overwritten. */
export const RECIPE_CASES: { name: string; input: string; ask?: string; folder: string; from: string; why: string }[] = [
  { name: 'Muffins reel', input: 'https://www.instagram.com/reel/EXAMPLE001/', folder: 'Recipes/Pastries', from: 'Recipes/Pastries/Blueberry Muffins', why: 'Posted with no words. It belongs in a Pastries folder, not Meal. A caption amount with no unit ("1/2 vanilla") must not be filled in silently.' },
  { name: 'Turkish eggs reel', input: 'https://www.instagram.com/reel/EXAMPLE002/', folder: 'Recipes/Meal', from: 'Recipes/Meal/Turkish eggs (cilbir)', why: 'Posted with no words; amounts may come from recipe sites as well as the reel, each with its source.' },
  { name: 'Mushroom soup reel', input: 'https://www.instagram.com/reel/EXAMPLE003/', folder: 'Recipes/Soup', from: 'Recipes/Soup/Creamy mushroom soup', why: 'Posted with no words. A soup goes in Soup, and amounts found later are filled into the existing recipe.' },
  { name: 'No-amounts reel', input: 'https://www.instagram.com/reel/EXAMPLE004/', folder: 'Recipes/Meal', from: 'Recipes/Meal/Crispy fried eggs', why: 'The reel gives no amounts. Any amount in the note has to be labeled an estimate or come from a page it opened.' },
  { name: 'Drink page', input: 'https://www.example.com/recipes/peach-cocktail', folder: 'Recipes/Drinks', from: 'Recipes/Drinks/Peach Cocktail', why: 'A link posted as "save <link>"; if web_fetch fails, fetch_page should read it.' },
  { name: 'Vodka sauce video', input: 'https://www.youtube.com/watch?v=EXAMPLE0005', ask: 'Just the vodka sauce from this one.', folder: 'Recipes/Sauce', from: 'Recipes/Sauce/Creamy Vodka Sauce', why: 'One video with several sauces; the note should take only the vodka sauce, in the video\'s grams with cup or spoon pairs.' },
  { name: 'Soup paste', input: 'https://pastebin.com/AbCd1234', folder: 'Recipes/Soup', from: 'Recipes/Soup/Hot and Sour Soup', why: 'A plain-text recipe on pastebin with a soup base measured in parts; units must stay as written.' },
  { name: 'Noodles reel', input: 'https://www.instagram.com/reel/EXAMPLE006/', folder: 'Recipes/Meal', from: 'Recipes/Meal/Stir-fried Noodles', why: 'A reel whose saved note also used a recipe site for amounts.' },
  { name: 'Bisque page', input: 'https://www.example.com/blog/shrimp-and-corn-bisque/', folder: 'Recipes/Soup', from: 'Recipes/Soup/Creamy Shrimp and Corn Bisque', why: 'A recipe page; a bisque is a soup and belongs in Soup, not Meal.' },
  { name: 'Curry halved', input: 'Chicken coconut curry', ask: 'Find two real recipes and cut it in half to serve 2.', folder: 'Recipes/Meal', from: 'Squire/Tasks/2026-11-15 Chicken coconut curry recipe', why: 'Asked by name. Scaled amounts must not be called estimates, and the serves count the sources leave out must be.' },
];

/** Writes the recipe cases into Factory/Evals/recipe/ when it has none. Returns what it wrote. */
export function seedRecipeCases(vault: Vault): string[] {
  if (loadCases(vault, 'recipe').length) return [];
  return RECIPE_CASES.map((c) => {
    const path = `${EVALS_FOLDER}/recipe/${c.name}.md`;
    if (vault.read(path) !== undefined) return '';
    const fields = { job: 'recipe', input: c.input, ...(c.ask ? { ask: c.ask } : {}), folder: c.folder, from: `[[${c.from}]]`, checks: [...CHECKS], tags: ['squire-eval-case'] };
    vault.write(path, `---\n${stringify(fields).trimEnd()}\n---\n\n# ${c.name}\n\n${c.why}\n`);
    return path;
  }).filter(Boolean);
}

/** A results note read back: when, which prompt, the pass rate and which cases failed which items. */
export interface EvalSummary {
  path: string;
  date: string;
  prompt: string;
  passed: number;
  total: number;
  failed: { case: string; items: string[] }[];
}

/** Every results note of a job, newest first. */
export function evalHistory(vault: Vault, job: string): EvalSummary[] {
  return vault
    .list(`${jobSettings(vault, job).evals}/results`)
    // Comparison notes (npm run improve) sit beside the results but aren't runs.
    .filter((path) => !/ compared(?: \d+)?\.md$/.test(path))
    .map((path) => {
      const text = vault.read(path) ?? '';
      const f = noteFields(text);
      const failed: EvalSummary['failed'] = [];
      for (const section of text.split(/^### /m).slice(1)) {
        const name = section.split('\n')[0]!.trim();
        const items = [...section.matchAll(/^- ❌ (.+)$/gm)].map((m) => m[1]!.trim());
        if (items.length) failed.push({ case: name, items });
      }
      return { path, date: String(f.date ?? ''), prompt: String(f.prompt ?? ''), passed: Number(f.passed) || 0, total: Number(f.total) || 0, failed };
    })
    .sort((a, b) => b.date.localeCompare(a.date) || b.path.localeCompare(a.path));
}

