import { stringify } from 'yaml';
import { RECIPES_FOLDER, type Vault } from '../../vault.js';
import { RECIPE_SCALING_PROMPT } from './notes.js';
import { BRIEF_SYSTEM } from './brief.js';
import { INBOX_EVENTS_SYSTEM } from './inboxEvents.js';
import { PHOTO_JOB_PROMPT } from './photo.js';
import { TRAINING_PROMPT } from './trainingTools.js';
import { VAULT_HEALTH_PROMPT } from './vaultHealth.js';
import { noteBody, noteFields } from './taskNotes.js';

/**
 * Factories: one specific job Squire does over and over, whose instructions,
 * state and results live in the vault where the owner can see and score them.
 * The first is "recipe": a reel, video or recipe link becomes a sourced note
 * in Recipes/.
 *
 * A job's instructions are versioned notes in Factory/Prompts/, named
 * "<job> vN.md", with frontmatter:
 *
 *   job: recipe
 *   process_step: what the prompt is for
 *   status: testing | production | retired
 *   version: 2
 *
 * A task runs the job's one production prompt, or the prompt it names. With
 * no prompt note at all, the built-in text below is used, so nothing breaks.
 */

export { FACTORY_FOLDER, PROMPTS_FOLDER, JOBS_FOLDER, FACTORY_README, FACTORY_POINTER, factoryGuard } from './factoryGuard.js';
import { FACTORY_FOLDER, PROMPTS_FOLDER, JOBS_FOLDER } from './factoryGuard.js';

export type PromptStatus = 'testing' | 'production' | 'retired';
export const PROMPT_STATUSES: PromptStatus[] = ['testing', 'production', 'retired'];

/** The built-in instructions for the recipe job: what it ran on before prompt notes. */
export const RECIPE_JOB_PROMPT = `You turn one recipe reel, video or recipe page link into a sourced recipe note in ${RECIPES_FOLDER}.
- Open the link before anything else: watch_video for videos and posts (YouTube, Instagram, TikTok), web_fetch for a page, fetch_page if web_fetch fails. Build the recipe only from what you opened: the caption, description, on-screen text and transcript of a video, or the page's own recipe. Creators often list ingredients in the caption or on screen and only say the steps. When a transcript and the screen disagree, trust the screen.
- Never invent an amount, time or step. Where the source leaves one out, write "(not given)". If you add your own suggestion, label it "(estimate)" right next to it, and say in the report which ones are estimates.
- Keep the source's own units and keep them consistent within the note; don't mix metric and US for the same kind of amount unless the source does.
- File it in the right subfolder of ${RECIPES_FOLDER}: list_notes ${RECIPES_FOLDER} first and use the subfolder that fits (Meal, Soup, Sauce, Sides, Pastries, Drinks, Coffee, Breakfast and so on). Soups go in Soup, baked goods in Pastries, not Meal. Make a new subfolder only when none fits.
- Start the note with a "Source:" line naming the creator or site and the link. Give the servings if the source says them.
- save_note with the links you opened in sources (mode create; if the title is taken, read that note and use a clearer title rather than replacing it).
- Your report says which note you saved, where, and anything missing or estimated.
${RECIPE_SCALING_PROMPT}`;

export type Trigger = 'scheduled' | 'event' | 'manual';
export type Tier = 'fast' | 'capable';

/**
 * A job built into the code: its built-in prompt and defaults. A job can also
 * be config only: a Factory/Jobs/<job>.md note plus its prompt notes, run as a
 * background task (npm run factory -- new <job> makes one).
 */
export interface JobDef {
  builtin: string;
  processStep: string;
  /** task: runs as a background task. code: a step the bot's code runs (the brief, inbox events), where only the prompt is versioned. */
  kind: 'task' | 'code';
  trigger: Trigger;
  /** Where its reports post, and where a hand-written task note for it reports by default. */
  channel: string;
  /** Shadow mode when its job note doesn't say. */
  shadow: boolean;
  tier: Tier;
  /** Its tasks get watch_video. */
  video?: boolean;
  /** Vault folders it may write; empty for none. */
  writePaths: string[];
  review: string;
}

/** The built-in instructions for research jobs: trip planning, comparisons, looking things up in depth. */
export const RESEARCH_JOB_PROMPT = `You research one question or plan one trip for the owner, and report back.
- Answer every numbered part of the goal, in its order, and say plainly for each part what you found and what you couldn't.
- Check anything they'd act on (prices, opening hours, availability, booking routes, visa rules, English support) against a primary source: the business's own site, the airline, the government page. Link it next to the fact. Marketing pages and listicles don't count as confirmation.
- Never state a live price, fare or availability you didn't see on a page this run; give a range and say where it came from, or mark it unverified.
- Mark anything unverified with "(unverified)" right where it appears, and gather the open questions at the end.
- Keep what's already booked as it is, and don't suggest changing it unless the goal asks.
- When the goal says to save or update a note, do it with save_note in the folder it names (trips in Travel/<trip>); otherwise save nothing.
- The report is a Discord message: short sections with bold labels and bullets, no tables.`;

/** Every job built into the code. Built-in prompts are read lazily, so these modules can import each other. */
export const JOBS: Record<string, JobDef> = {
  recipe: { builtin: RECIPE_JOB_PROMPT, processStep: 'reel or recipe link to a sourced Recipes note', kind: 'task', trigger: 'event', video: true, channel: 'recipes', shadow: true, tier: 'capable', writePaths: [RECIPES_FOLDER], review: 'weekly' },
  research: { builtin: RESEARCH_JOB_PROMPT, processStep: 'a research or trip-planning ask to a sourced report', kind: 'task', trigger: 'manual', channel: 'travel', shadow: true, tier: 'capable', writePaths: ['Travel'], review: 'weekly' },
  'inbox-calendar': {
    get builtin() {
      return INBOX_EVENTS_SYSTEM;
    },
    processStep: 'recent emails to booked events on the calendar',
    kind: 'code',
    trigger: 'scheduled',
    channel: 'misc',
    shadow: true,
    tier: 'fast',
    writePaths: [],
    review: 'weekly',
  },
  brief: {
    get builtin() {
      return BRIEF_SYSTEM;
    },
    processStep: "the day's computed facts to the morning brief's wording",
    kind: 'code',
    trigger: 'scheduled',
    channel: 'misc',
    shadow: true,
    tier: 'fast',
    writePaths: [],
    review: 'weekly',
  },
  photo: {
    get builtin() {
      return PHOTO_JOB_PROMPT;
    },
    processStep: 'a photo sent with no ask to the action it is for (one per line: "- (tool group) what it shows => what to do")',
    kind: 'code',
    trigger: 'event',
    channel: 'misc',
    shadow: false,
    tier: 'fast',
    writePaths: [],
    review: 'monthly',
  },
  'training-log': {
    get builtin() {
      return TRAINING_PROMPT.trim();
    },
    processStep: 'sets reported in chat to sets logged in the training log',
    kind: 'code',
    trigger: 'event',
    channel: 'misc',
    shadow: false,
    tier: 'fast',
    writePaths: [],
    review: 'monthly',
  },
  'vault-health': {
    get builtin() {
      return VAULT_HEALTH_PROMPT;
    },
    processStep: 'candidate notes to a checklist of tidy-up proposals (archive, file, merge, update) the owner ticks',
    kind: 'code',
    trigger: 'scheduled',
    channel: 'misc',
    shadow: false,
    tier: 'fast',
    writePaths: ['Squire/Health'],
    review: 'weekly',
  },
};
export const JOB_NAMES = Object.keys(JOBS);

/** Every job: the built-in ones and any with only a note in Factory/Jobs. */
export function jobNames(vault: Vault | undefined): string[] {
  const noted = vault ? vault.list(JOBS_FOLDER).map((p) => p.split('/').at(-1)!.replace(/\.md$/, '').toLowerCase()) : [];
  return [...new Set([...JOB_NAMES, ...noted])];
}

export interface JobPrompt {
  job: string;
  /** The prompt note's name, e.g. "recipe v2"; "built-in" when no note was found. */
  name: string;
  /** Vault path of the prompt note, when it came from one. */
  path?: string;
  version?: number;
  status?: PromptStatus;
  text: string;
}

export interface PromptNote {
  path: string;
  name: string;
  job: string;
  status: string;
  version: number;
  processStep: string;
  text: string;
}

/** Every prompt note in Factory/Prompts, with its fields. */
export function promptNotes(vault: Vault): PromptNote[] {
  return vault.list(PROMPTS_FOLDER).map((path) => {
    const raw = vault.read(path) ?? '';
    const f = noteFields(raw);
    return {
      path,
      name: path.split('/').at(-1)!.replace(/\.md$/, ''),
      job: String(f.job ?? '').trim().toLowerCase(),
      status: String(f.status ?? '').trim().toLowerCase(),
      version: Number(f.version) || 0,
      processStep: String(f.process_step ?? ''),
      text: noteBody(raw).trim(),
    };
  });
}

/**
 * The prompt a job's task runs: the one it names ("recipe v2", with or
 * without .md or the folder), else the job's production prompt (the highest
 * version if more than one is marked production), else the built-in text.
 * Throws for an unknown job or a named prompt that doesn't exist.
 */
export function jobPrompt(vault: Vault | undefined, job: string, named?: string): JobPrompt {
  const def = JOBS[job];
  if (!def && !jobNames(vault).includes(job)) throw new Error(`No job called "${job}". Jobs: ${jobNames(vault).join(', ')}.`);
  const notes = vault ? promptNotes(vault).filter((n) => n.text) : [];
  const want = named?.trim().replace(/^\[\[|\]\]$/g, '').split('/').at(-1)?.replace(/\.md$/i, '').toLowerCase();
  if (want) {
    const hit = notes.find((n) => n.name.toLowerCase() === want);
    if (!hit) throw new Error(`No prompt note "${named}" in ${PROMPTS_FOLDER}.`);
    if (hit.job && hit.job !== job) throw new Error(`Prompt "${hit.name}" is for the ${hit.job} job, not ${job}.`);
    return { job, name: hit.name, path: hit.path, version: hit.version, status: hit.status as PromptStatus, text: hit.text };
  }
  const production = notes.filter((n) => n.job === job && n.status === 'production').sort((a, b) => b.version - a.version);
  if (production.length > 1) console.warn(`[factory] ${production.length} production prompts for ${job}; using ${production[0]!.name}. Retire the others.`);
  const pick = production[0];
  if (pick) return { job, name: pick.name, path: pick.path, version: pick.version, status: 'production', text: pick.text };
  if (!def) throw new Error(`The ${job} job has no production prompt yet: set status: production on one of its notes in ${PROMPTS_FOLDER}.`);
  return { job, name: 'built-in', text: def.builtin };
}

/**
 * Writes "<job> v1.md" with the built-in prompt, as production, for each job
 * that has no prompt note yet: the instructions move into the vault without
 * changing. Never touches a job that has any prompt note. Returns what it wrote.
 */
export function seedPrompts(vault: Vault): string[] {
  const have = new Set(promptNotes(vault).map((n) => n.job));
  const wrote: string[] = [];
  for (const [job, def] of Object.entries(JOBS)) {
    const path = `${PROMPTS_FOLDER}/${job} v1.md`;
    if (have.has(job) || vault.read(path) !== undefined) continue;
    const fields = { job, process_step: def.processStep, status: 'production', version: 1 };
    vault.write(path, `---\n${stringify(fields).trimEnd()}\n---\n\n${def.builtin}\n`);
    wrote.push(path);
  }
  return wrote;
}

export interface JobSettings {
  job: string;
  kind: 'task' | 'code';
  trigger: Trigger;
  channel: string;
  /** Shadow mode: the job proposes its result in the task report and changes nothing else until the owner promotes it. */
  shadow: boolean;
  /** Which model: fast (the chat model) or capable (the task model). */
  tier: Tier;
  effort?: string;
  /** Tools it may use; empty for all its kind gets. */
  tools: string[];
  /** Vault folders it may write. */
  writePaths: string[];
  /** Its eval cases. */
  evals: string;
  review: string;
  /** Most it may spend a day, in USD; 0 for no cap. */
  dailyCapUsd: number;
}

const truthy = (v: unknown) => v === true || /^(true|yes|on)$/i.test(String(v ?? '').trim());
const list = (v: unknown) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : typeof v === 'string' && v.trim() ? v.split(',').map((x) => x.trim()) : undefined);

/**
 * A job's settings from Factory/Jobs/<job>.md, with the built-in defaults for
 * anything it doesn't say. Model choice lives here (tier, effort), so it can
 * change without a deploy.
 */
export function jobSettings(vault: Vault | undefined, job: string): JobSettings {
  const def = JOBS[job];
  const f = vault ? noteFields(vault.read(`${JOBS_FOLDER}/${job}.md`) ?? '') : {};
  const trigger = String(f.trigger ?? def?.trigger ?? 'manual') as Trigger;
  const tier = String(f.tier ?? def?.tier ?? 'capable') === 'fast' ? 'fast' : 'capable';
  return {
    job,
    kind: def?.kind ?? 'task',
    trigger: ['scheduled', 'event', 'manual'].includes(trigger) ? trigger : 'manual',
    channel: String(f.channel ?? def?.channel ?? 'misc').replace(/^#/, ''),
    shadow: f.shadow === undefined ? (def?.shadow ?? true) : truthy(f.shadow),
    tier,
    ...(f.effort ? { effort: String(f.effort) } : {}),
    tools: list(f.tools) ?? [],
    writePaths: list(f.write_paths) ?? def?.writePaths ?? [],
    evals: String(f.evals ?? `${FACTORY_FOLDER}/Evals/${job}`).replace(/^\[\[|\]\]$/g, ''),
    review: String(f.review ?? def?.review ?? 'weekly'),
    dailyCapUsd: f.daily_cap_usd !== undefined && Number.isFinite(Number(f.daily_cap_usd)) ? Math.max(0, Number(f.daily_cap_usd)) : tier === 'fast' ? 0.5 : 3,
  };
}

/** A job note's text: the frontmatter the README describes, then what the job is for. */
function jobNoteText(job: string, s: Omit<JobSettings, 'job' | 'kind'>, what: string): string {
  const fields = {
    job,
    trigger: s.trigger,
    channel: `#${s.channel}`,
    tools: s.tools,
    write_paths: s.writePaths,
    shadow: s.shadow,
    tier: s.tier,
    ...(s.effort ? { effort: s.effort } : {}),
    evals: `[[${s.evals}]]`,
    review: s.review,
    daily_cap_usd: s.dailyCapUsd,
    tags: ['squire-job'],
  };
  return (
    `---\n${stringify(fields).trimEnd()}\n---\n\n# ${job} job\n\n${what}\n\n` +
    '- **shadow**: true means the job writes its proposed result into the task report and touches nothing else. Say "promote" in Discord to save a proposal. Set it to false after a clean stretch.\n' +
    '- **tier**: fast (the chat model) or capable (the task model); **effort**: low to max. Changes apply from the next run, no deploy.\n' +
    '- **tools** and **write_paths** limit what it may use and where it may write, enforced in code. Empty means everything its kind gets, or anywhere the notes tools allow. Add web_search or web_fetch to tools to keep web access.\n' +
    '- **daily_cap_usd**: the most it may spend in a day (from the activity log). Over it, a running task stops and new runs wait for tomorrow.\n'
  );
}

/** Writes Factory/Jobs/<job>.md with the defaults for each built-in job that has none. Never touches one that exists. */
export function seedJobs(vault: Vault): string[] {
  const wrote: string[] = [];
  for (const [job, def] of Object.entries(JOBS)) {
    const path = `${JOBS_FOLDER}/${job}.md`;
    if (vault.read(path) !== undefined) continue;
    vault.write(path, jobNoteText(job, jobSettings(undefined, job), `${def.processStep}.`));
    wrote.push(path);
  }
  return wrote;
}

/**
 * The "factory factory": a new config-only job. Writes its job note, a first
 * prompt (testing, until the owner makes it production) and an example eval
 * case. Refuses if the job exists. Returns what it wrote.
 */
export function scaffoldJob(vault: Vault, job: string, o: { trigger?: Trigger; channel?: string; what?: string } = {}): string[] {
  const name = job.trim().toLowerCase();
  if (!/^[a-z][a-z0-9-]{1,30}$/.test(name)) throw new Error('A job name is lowercase letters, digits and dashes, e.g. "receipts".');
  if (jobNames(vault).includes(name)) throw new Error(`There's already a ${name} job.`);
  const settings = { ...jobSettings(undefined, name), trigger: o.trigger ?? 'manual', channel: (o.channel ?? 'misc').replace(/^#/, ''), shadow: true };
  const what = o.what?.trim() || 'What this job does, its input and its output, in a sentence or two.';
  const files: [string, string][] = [
    [`${JOBS_FOLDER}/${name}.md`, jobNoteText(name, settings, what)],
    [
      `${PROMPTS_FOLDER}/${name} v1.md`,
      `---\n${stringify({ job: name, process_step: what, status: 'testing', version: 1 }).trimEnd()}\n---\n\nYou do one job: ${what}\n- Work only from what you open and read; never invent a fact.\n- Your report says what you produced and where, and anything missing.\n`,
    ],
    [
      `${settings.evals}/Example.md`,
      `---\n${stringify({ job: name, input: 'The input for one real run, e.g. a link or the text the owner sent.', checklist: ['The output says where its facts came from.', 'Nothing in the output is invented.'], tags: ['squire-eval-case'] }).trimEnd()}\n---\n\n# Example\n\nReplace this with a real past run: its input, and a checklist of what must be true of the result.\n`,
    ],
  ];
  for (const [path] of files) if (vault.read(path) !== undefined) throw new Error(`${path} already exists.`);
  for (const [path, text] of files) vault.write(path, text);
  return files.map(([p]) => p);
}

const REGISTRY_START = '<!-- squire:registry -->';
const REGISTRY_END = '<!-- /squire:registry -->';

/** The job registry table: one row per job, from code and the vault. */
export function registryTable(vault: Vault, lastEval: (job: string) => { passed: number; total: number; date: string } | undefined): string {
  const rows = jobNames(vault).map((job) => {
    const s = jobSettings(vault, job);
    let prompt = '';
    try {
      prompt = jobPrompt(vault, job).name;
    } catch {
      prompt = '';
    }
    const status = String(noteFields(vault.read(`${JOBS_FOLDER}/${job}.md`) ?? '').status ?? (prompt ? (s.shadow ? 'shadow' : 'live') : 'planned'));
    const last = lastEval(job);
    const rate = last && last.total ? `${Math.round((last.passed / last.total) * 100)}% (${last.passed}/${last.total}, ${last.date.slice(0, 10)})` : '';
    return `| ${job} | ${status} | ${s.shadow ? 'yes' : 'no'} | ${prompt} | ${rate} |`;
  });
  return `| Job | Status | Shadow | Prompt | Last eval pass rate |\n|---|---|---|---|---|\n${rows.join('\n')}`;
}

/**
 * The README with its job registry table regenerated. Only the text between
 * the marker comments changes. Without markers, the table under "## Job
 * registry" is wrapped in them (or the section is added at the end): that
 * first edit is shown as a dry run before it's applied.
 */
export function withRegistry(readme: string, table: string): string {
  const block = `${REGISTRY_START}\n${table}\n${REGISTRY_END}`;
  const a = readme.indexOf(REGISTRY_START);
  const b = readme.indexOf(REGISTRY_END);
  if (a >= 0 && b > a) return `${readme.slice(0, a)}${block}${readme.slice(b + REGISTRY_END.length)}`;
  const heading = /^##\s+Job registry\s*$/im.exec(readme);
  if (heading) {
    const after = readme.slice(heading.index + heading[0].length);
    const tableMatch = /^[ \t]*\n(?:[ \t]*\n)*((?:\|.*\|[ \t]*(?:\n|$))+)/.exec(after);
    if (tableMatch) {
      const start = heading.index + heading[0].length + tableMatch.index + tableMatch[0].length - tableMatch[1]!.length;
      const end = start + tableMatch[1]!.replace(/\n$/, '').length;
      return `${readme.slice(0, start)}${block}${readme.slice(end)}`;
    }
    return `${readme.slice(0, heading.index + heading[0].length)}\n\n${block}\n${after}`;
  }
  return `${readme.trimEnd()}\n\n## Job registry\n\n${block}\n`;
}

/** Whether the README already has the registry markers, so updates are routine and need no dry run. */
export const hasRegistryMarkers = (readme: string) => readme.includes(REGISTRY_START) && readme.includes(REGISTRY_END);
