import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  profilePrompt,
  runTools,
  toolMap,
  type Effort,
  type LLM,
  type Generation,
  type ModelOptions,
  type OwnerProfile,
  type ToolDef,
  type ToolHandler,
  type ToolResult,
  type Turn,
} from './llm.js';
import type { ReminderStore } from './reminders.js';
import { reminderTools } from './reminderTools.js';
import { memoryTools, type MemoryStore } from './memory.js';
import { toLocalIso, toLocalShort } from './time.js';
import { GOOGLE_TASK_PROMPT, googleTools, mailboxPrompt, type GoogleAccount } from './google.js';
import { createHash } from 'node:crypto';
import { NOTES_TASK_BASE, NOTES_TASK_PROMPT, notesTools, TASK_NOTE_TOOLS, type ProposedNote } from './notes.js';
import { FACTORY_POINTER, jobNames, JOBS, jobPrompt, jobSettings, seedJobs, seedPrompts, type JobPrompt } from './factory.js';
import { videoTools } from './video.js';
import { migrateTaskNotes, noteFields, readProposal, setNoteFields, todoNotes, wikiLink, writeTaskNote } from './taskNotes.js';
import { TASKS_FOLDER } from '../../vault.js';
import type { Vault } from '../../vault.js';
import { placesPrompt, placesTools } from './placesTools.js';
import { linkTools } from './linkTools.js';
import type { SavedPlaces } from './places.js';
import type { Journal } from './journal.js';
import { traceTools, type ActivityLog } from './activity.js';
import { overCap, toolAllowed, webAllowed } from './governance.js';
import { addUsage } from './usage.js';
import type { Usage } from './llm.js';
import type { ReadLog } from './readLog.js';
import type { StyleStore } from './style.js';

/**
 * Background tasks ("subagents"). The chat assistant hands one off when a job
 * is too big for a single reply or has to play out over time — research that
 * takes many searches, or "watch this and tell me when it changes". Each task
 * is its own model conversation with its own tools, and it lives exactly as
 * long as its job: it ends when it calls finish_task, and it cannot outlive
 * the deadline it was given.
 *
 * A task that needs to check back later calls wait_until. Its conversation is
 * saved to disk and picked up again at that time — after a restart too — so a
 * task that spans days costs nothing while it waits.
 */

/** fast: the chat model, for simple checks. capable: the task model, for real work. */
export type TaskTier = 'fast' | 'capable';
export const TIERS: TaskTier[] = ['fast', 'capable'];

export type TaskStatus = 'queued' | 'running' | 'waiting' | 'done' | 'gave_up' | 'cancelled' | 'failed';
const ACTIVE: TaskStatus[] = ['queued', 'running', 'waiting'];

export interface Task {
  id: string;
  title: string;
  goal: string;
  doneWhen: string;
  /** UTC ISO. The task is wrapped up at this point whatever its progress. */
  deadline: string;
  channelId: string;
  channelName: string;
  status: TaskStatus;
  /** Which model works on it; fixed for the task's life. Older tasks: capable. */
  tier?: TaskTier;
  createdAt: string;
  /** When a queued or waiting task should next run. */
  wakeAt?: string;
  waitReason?: string;
  messages: Turn[];
  /** Results of the calls made alongside wait_until, sent back on resume. */
  pending?: { waitId: string; results: ToolResult[] };
  apiCalls: number;
  updates: number;
  errors: number;
  lastUpdate?: string;
  result?: string;
  finishedAt?: string;
  /** Tokens used over the task's life, for the activity log. */
  usage?: Usage;
  /** Tools it called, failures with their error; capped. */
  toolLog?: string[];
  /** Its note in Squire/Tasks, vault-relative; set once the note is first written. */
  note?: string;
  /** The owner wrote that note by hand (status: todo): only its frontmatter is changed, and the report is added at the end. */
  ownNote?: boolean;
  /** The note it saved last, vault-relative: what the task produced. */
  output?: string;
  /** The factory job it runs, e.g. "recipe"; none for a one-off task. */
  job?: string;
  /** The job's prompt it runs, by note name ("recipe v2") or "built-in"; fixed when it starts. */
  prompt?: string;
  /** That prompt note's vault path. */
  promptNote?: string;
  /** Shadow mode, from the job's settings when it started: save_note only proposes. */
  shadow?: boolean;
  /** The note a shadow run would have written; base is a hash of what was there then. */
  proposal?: ProposedNote & { base?: string };
}

/** A short hash of a note's text, to tell whether it changed between a proposal and its promotion. */
const hashOf = (text: string | undefined) => createHash('sha1').update(text ?? '').digest('hex').slice(0, 12);

/** Most tool entries a task keeps for the activity log. */
const MAX_TOOL_LOG = 80;

export interface TaskLimits {
  /** Tasks running at the same moment; more wait their turn. */
  concurrent: number;
  /** Unfinished tasks at once. */
  active: number;
  /** Furthest a deadline may be set. */
  maxDeadlineDays: number;
  /** API calls in one stretch of work before a task must wait or finish. */
  roundsPerRun: number;
  /** API calls over a task's whole life. */
  totalCalls: number;
  /** Progress messages a task may post. */
  updates: number;
}

export const DEFAULT_LIMITS: TaskLimits = {
  concurrent: 3,
  active: 10,
  maxDeadlineDays: 30,
  roundsPerRun: 25,
  totalCalls: 150,
  updates: 10,
};

/** Finished tasks kept for list_tasks; older ones are dropped. */
const KEEP_FINISHED = 20;
/** Grace after the deadline for a task in the middle of work to wrap up. */
const DEADLINE_GRACE_MS = 10 * 60_000;
const RETRY_AFTER_ERROR_MS = 5 * 60_000;
const MAX_ERRORS = 3;

export class TaskStore {
  private tasks: Task[] = [];

  constructor(private readonly path: string) {
    if (existsSync(path)) {
      this.tasks = (JSON.parse(readFileSync(path, 'utf8')) as { tasks?: Task[] }).tasks ?? [];
    }
  }

  all(): Task[] {
    return this.tasks;
  }

  get(id: string): Task | undefined {
    return this.tasks.find((t) => t.id === id);
  }

  add(task: Task) {
    this.tasks.push(task);
    this.save();
  }

  save() {
    // Finished tasks keep only their summary; the conversation is dropped.
    const finished = this.tasks.filter((t) => !ACTIVE.includes(t.status));
    const drop = new Set(finished.slice(0, Math.max(0, finished.length - KEEP_FINISHED)).map((t) => t.id));
    this.tasks = this.tasks.filter((t) => !drop.has(t.id));
    for (const t of this.tasks) {
      if (!ACTIVE.includes(t.status)) {
        t.messages = [];
        delete t.pending;
      }
    }
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify({ tasks: this.tasks }, null, 2));
    renameSync(tmp, this.path);
  }
}

export interface TaskRunnerOptions {
  llm: LLM;
  /** The model for capable-tier tasks. */
  model: string;
  /** The model for fast-tier tasks (the chat model). */
  fastModel: string;
  effort: Effort;
  timeZone: string;
  reminders: ReminderStore;
  profile?: OwnerProfile;
  memory?: MemoryStore;
  /** Read-only Gmail and Calendar access. */
  google?: GoogleAccount;
  /** Finished reports are also saved as notes here. */
  vault?: Vault;
  /** Pages and videos actually opened; recipe notes may only cite these. */
  reads?: ReadLog;
  /** The owner's saved Google Maps lists, read-only. */
  places?: SavedPlaces;
  /** Earlier conversations, for the background on a task. */
  journal?: Journal;
  /** Where finished tasks are logged, with what they cost. */
  activity?: ActivityLog;
  /** How the owner writes; updates and reports are written in that voice. */
  style?: StyleStore;
  limits?: Partial<TaskLimits>;
}

/** Posts a message to a channel; `ping` mentions the owner. */
export type Poster = (channelId: string, content: string, ping: boolean) => Promise<void>;

const SYSTEM = `You are a background worker for Squire, a personal assistant on Discord. You were handed one task by the assistant on behalf of its owner. Nobody is watching you work: the owner only sees what you post with post_update and the report you give finish_task.

How to work:
- Stay inside the task. Its "Done when" line is your finish line; when it's met, call finish_task straight away. Don't expand the scope.
- Search the web and read pages for anything you need to know. Check facts that matter (prices, times, availability) against a primary source.
- If the task means checking on something over time, do one check, then call wait_until with the next sensible time to look again. Pick intervals that suit the thing being watched (hours for prices, a day for slow-moving news) — not minutes unless it really changes that fast.
- post_update only for things the owner would want to know before the end: a real change, a decision they need to make, or a long task's halfway findings. Not for "starting now" or "still looking".
- You may set reminders for the owner if the task calls for it.
- If you can't complete it — the information doesn't exist, or the deadline arrives — call finish_task with outcome "gave_up" and say what you found and what's missing.
- Use US units by default: miles, feet, °F, pounds, ounces, cups, mph. Convert anything a source gives in metric ("about 3 miles"), unless they ask for metric or it's a recipe's own measurements.
- Your finish_task report is what the owner reads: it is posted in the channel the task came from, with a ping, so that is your reply there. Don't tell them you can't post. Lead with the answer. Keep it tight: it's a Discord message, so bullets and **bold** work, tables and # headings don't. Include links for anything they'd act on.
- Every turn must end in a tool call: keep working, wait_until, or finish_task.`;

export class TaskRunner {
  private readonly running = new Set<string>();
  private readonly limits: TaskLimits;
  private readonly effort: Effort;
  private readonly system: string;
  /** The system prompt without the generic recipe rules, for job tasks: the job's prompt goes on the end. */
  private readonly jobSystem: string;
  private post: Poster = async () => {};
  /** A channel's id from its name, for hand-written task notes; set once Discord is connected. */
  private findChannel?: (name: string) => string | undefined;

  constructor(
    private readonly store: TaskStore,
    private readonly opts: TaskRunnerOptions,
  ) {
    this.limits = { ...DEFAULT_LIMITS, ...opts.limits };
    // Tasks are the multi-step work, so they think at least at medium.
    const order: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
    const effort = order.indexOf(opts.effort) < 1 ? 'medium' : opts.effort;
    this.effort = effort;
    const build = (notes: string) =>
      SYSTEM +
      (opts.memory ? '\n- If you learn something durable about the owner that would help later (a preference, a plan, a constraint), save it with remember.' : '') +
      (opts.google ? GOOGLE_TASK_PROMPT + mailboxPrompt(opts.google) : '') +
      (opts.places ? placesPrompt(opts.places, { readOnly: true }) : '') +
      (opts.vault ? notes : '') +
      '\n- If web_fetch fails on a page or comes back blocked, try fetch_page on the same link before giving up on it.' +
      profilePrompt(opts.profile);
    this.system = build(NOTES_TASK_PROMPT + FACTORY_POINTER);
    this.jobSystem = build(NOTES_TASK_BASE + FACTORY_POINTER);
    if (opts.vault) {
      const migrated = migrateTaskNotes(opts.vault);
      if (migrated.length) console.log(`[tasks] added a status to ${migrated.length} older task note(s): ${migrated.join(', ')}`);
      try {
        const seeded = [...seedPrompts(opts.vault), ...seedJobs(opts.vault)];
        if (seeded.length) console.log(`[factory] wrote the built-in prompt(s) to ${seeded.join(', ')}`);
      } catch (err) {
        console.error('[factory] could not write the prompt notes:', err);
      }
    }
    // A task that was mid-run when the bot stopped picks up where it left off.
    for (const t of store.all()) {
      if (t.status === 'running') {
        t.status = 'queued';
        t.wakeAt = new Date().toISOString();
      }
    }
  }

  /** The vault tasks write to, if notes are on. */
  get vault() {
    return this.opts.vault;
  }

  /** Where tasks post, and how a hand-written note's channel name is found; set once Discord is connected. */
  setPoster(post: Poster, findChannel?: (name: string) => string | undefined) {
    this.post = post;
    this.findChannel = findChannel;
  }

  list(): Task[] {
    return this.store.all();
  }

  active(): Task[] {
    return this.store.all().filter((t) => ACTIVE.includes(t.status));
  }

  private modelFor(task: Task): ModelOptions {
    // A job's model is set in its job note (tier, effort), so it can change without a deploy.
    const settings = task.job ? jobSettings(this.opts.vault, task.job) : undefined;
    const tier = settings?.tier ?? task.tier;
    const effort = settings?.effort && (['low', 'medium', 'high', 'xhigh', 'max'] as string[]).includes(settings.effort) ? (settings.effort as Effort) : this.effort;
    return { model: tier === 'fast' ? this.opts.fastModel : this.opts.model, effort };
  }

  start(
    input: {
      title: string;
      goal: string;
      doneWhen: string;
      deadline: Date;
      tier?: TaskTier;
      channelId: string;
      channelName: string;
      /** A hand-written note in Squire/Tasks this task runs from. */
      ownNote?: string;
      /** A factory job, e.g. "recipe". */
      job?: string;
      /** A prompt note to run instead of the job's production prompt. */
      prompt?: string;
    },
    now = new Date(),
  ): Task {
    const { title, goal, doneWhen, deadline } = input;
    if (!title.trim() || !goal.trim() || !doneWhen.trim()) throw new Error('A task needs a title, a goal, and a done_when.');
    if (Number.isNaN(deadline.getTime())) throw new Error('The deadline is not a valid date and time.');
    if (deadline.getTime() <= now.getTime() + 60_000) throw new Error('The deadline must be in the future.');
    if (deadline.getTime() > now.getTime() + this.limits.maxDeadlineDays * 86_400_000) {
      throw new Error(`Deadlines can be at most ${this.limits.maxDeadlineDays} days out; split it or pick a nearer end point.`);
    }
    if (this.active().length >= this.limits.active) {
      throw new Error(`There are already ${this.limits.active} unfinished tasks; cancel one first.`);
    }
    const job = input.job?.trim().toLowerCase() || undefined;
    if (!job && input.prompt?.trim()) throw new Error('A prompt can only be named for a factory job.');
    if (job && jobSettings(this.opts.vault, job).kind === 'code') throw new Error(`${job} is a step the bot runs itself, not a task job.`);
    const capped = job ? overCap(this.opts.vault, this.opts.activity, job, this.opts.timeZone, now) : undefined;
    if (capped) throw new Error(`${capped} Start it tomorrow, or raise the cap.`);
    const prompt = job ? jobPrompt(this.opts.vault, job, input.prompt) : undefined;
    const task: Task = {
      id: randomUUID().slice(0, 8),
      title: title.trim(),
      goal: goal.trim(),
      doneWhen: doneWhen.trim(),
      deadline: deadline.toISOString(),
      channelId: input.channelId,
      channelName: input.channelName,
      status: 'queued',
      tier: input.tier ?? 'capable',
      createdAt: now.toISOString(),
      wakeAt: now.toISOString(),
      messages: [],
      apiCalls: 0,
      updates: 0,
      errors: 0,
      ...(input.ownNote ? { note: input.ownNote, ownNote: true } : {}),
      ...(job && prompt ? { job, prompt: prompt.name, ...(prompt.path ? { promptNote: prompt.path } : {}) } : {}),
      ...(job && jobSettings(this.opts.vault, job).shadow ? { shadow: true } : {}),
    };
    this.store.add(task);
    this.writeNote(task);
    queueMicrotask(() => this.tick());
    return task;
  }

  cancel(id: string): Task {
    const task = this.store.get(id);
    if (!task) throw new Error(`No task with id "${id}".`);
    if (!ACTIVE.includes(task.status)) throw new Error(`Task ${id} already ended (${task.status}).`);
    // A run in progress notices the status change before its next API call.
    this.end(task, 'cancelled', 'Cancelled by the owner.');
    return task;
  }

  /** Starts whatever is due, up to the concurrency limit. Call on a timer. */
  tick(now = new Date()): Promise<void>[] {
    this.pickUp(now);
    const started: Promise<void>[] = [];
    const due = this.store
      .all()
      .filter((t) => (t.status === 'queued' || t.status === 'waiting') && !this.running.has(t.id))
      .filter((t) => !t.wakeAt || new Date(t.wakeAt) <= now)
      .sort((a, b) => (a.wakeAt ?? '').localeCompare(b.wakeAt ?? ''));
    for (const task of due) {
      if (this.running.size >= this.limits.concurrent) break;
      this.running.add(task.id);
      started.push(
        this.run(task)
          .catch((err) => console.error(`[task ${task.id}] crashed:`, err))
          .finally(() => this.running.delete(task.id)),
      );
    }
    return started;
  }

  /**
   * Starts the notes the owner wrote in Squire/Tasks with status: todo. One
   * that can't start (no Goal, a bad deadline) is marked failed with the
   * reason in its outcome, so it isn't retried every tick.
   */
  private pickUp(now: Date) {
    const vault = this.opts.vault;
    if (!vault || !this.findChannel) return;
    let todos;
    try {
      todos = todoNotes(vault);
    } catch (err) {
      console.error('[tasks] could not read Squire/Tasks:', err);
      return;
    }
    for (const n of todos) {
      if (this.store.all().some((t) => t.note === n.path && ACTIVE.includes(t.status))) continue;
      if (this.active().length >= this.limits.active) return; // the rest wait as todo
      try {
        if (!n.goal || !n.doneWhen) throw new Error('it needs a Goal and a Done when.');
        const job = String(n.fields.job ?? '').trim().toLowerCase();
        const channelName = String(n.fields.channel ?? '').trim().replace(/^#/, '') || (job ? jobSettings(vault, job).channel : 'misc');
        const channelId = this.findChannel(channelName);
        if (!channelId) throw new Error(`there's no #${channelName} channel to report in.`);
        const deadline = n.fields.deadline ? new Date(String(n.fields.deadline)) : new Date(now.getTime() + 86_400_000);
        const tier = TIERS.includes(n.fields.tier as TaskTier) ? (n.fields.tier as TaskTier) : 'capable';
        const prompt = n.fields.prompt ? String(n.fields.prompt) : undefined;
        this.start({ title: n.title, goal: n.goal, doneWhen: n.doneWhen, deadline, tier, channelId, channelName, ownNote: n.path, job: job || undefined, prompt }, now);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        console.error(`[tasks] could not start ${n.path}: ${reason}`);
        try {
          vault.write(n.path, setNoteFields(vault.read(n.path) ?? '', { status: 'failed', outcome: `not started: ${reason}` }));
        } catch (e) {
          console.error(`[tasks] could not mark ${n.path} failed:`, e);
        }
      }
    }
  }

  /** A shadow run's note: kept on the task and shown in its note, not written. */
  private propose(task: Task, p: ProposedNote) {
    task.proposal = { ...p, base: hashOf(this.opts.vault?.read(p.path)) };
    this.writeNote(task);
  }

  /**
   * Saves a shadow run's proposed note for real: the owner's approval. Finds
   * the task by id, or its note in Squire/Tasks by title (the latest with a
   * proposal when nothing is given). Refuses when the target note appeared or
   * changed since the proposal, so nothing of the owner's is overwritten.
   */
  promote(ref = ''): string {
    const vault = this.opts.vault;
    if (!vault) throw new Error('Notes are off, so there is nothing to promote.');
    const want = ref.trim().toLowerCase();
    const byId = want ? this.store.get(want) : undefined;
    const candidates = vault
      .list(TASKS_FOLDER)
      .filter((p) => !want || byId?.note === p || p.toLowerCase().includes(want))
      .map((p) => ({ p, text: vault.read(p) ?? '' }))
      .filter((n) => readProposal(n.text) && !noteFields(n.text).promoted)
      .sort((a, b) => vault.mtime(b.p) - vault.mtime(a.p));
    const hit = candidates[0];
    if (!hit) throw new Error(want ? `No task "${ref}" with a proposal waiting.` : 'No shadow proposals are waiting.');
    const p = readProposal(hit.text)!;
    const existing = vault.read(p.path);
    if (p.mode === 'create' && existing !== undefined) throw new Error(`${p.path} exists now, so the proposal would overwrite it. Rename or move that note first.`);
    if (p.mode !== 'create' && p.base && hashOf(existing) !== p.base) throw new Error(`${p.path} changed since the proposal, so saving it would lose those changes. Run the job again.`);
    vault.write(p.path, p.content);
    const promoted = toLocalIso(new Date(), this.opts.timeZone);
    vault.write(hit.p, setNoteFields(hit.text, { output: wikiLink(p.path), promoted }));
    const task = this.store.all().find((t) => t.note === hit.p);
    if (task) {
      task.output = p.path;
      this.store.save();
    }
    return `Saved ${p.path} from ${hit.p}.`;
  }

  /** Writes the task's note in the vault; a failure is logged, never fatal. */
  private writeNote(task: Task): string | undefined {
    if (!this.opts.vault) return undefined;
    try {
      return writeTaskNote(this.opts.vault, task, this.opts.timeZone);
    } catch (err) {
      console.error(`[tasks] could not write the note for ${task.id}:`, err);
      return undefined;
    }
  }

  /**
   * The task's system prompt. A job task runs the prompt it started with
   * (the note as it is now, so a fix to that version applies), or the
   * built-in one if that note has gone.
   */
  private systemFor(task: Task): string {
    if (!task.job) return this.system;
    let prompt: JobPrompt;
    try {
      prompt = jobPrompt(this.opts.vault, task.job, task.prompt === 'built-in' ? undefined : task.prompt);
    } catch {
      prompt = { job: task.job, name: 'built-in', text: JOBS[task.job]?.builtin ?? '' };
    }
    const shadow = task.shadow
      ? '\n\nThis job is in shadow mode: save_note checks the note and proposes it instead of saving it, and you have no other tools that change anything. Work exactly as if it were saved, then say in the report which note you propose and that it waits for the owner\'s OK.'
      : '';
    return `${this.jobSystem}\n\nThis task is the ${task.job} factory's job, run with the prompt "${prompt.name}":\n${prompt.text}${shadow}`;
  }

  private tools(task: Task): { tools: ToolDef[]; handlers: Map<string, ToolHandler> } {
    const tz = this.opts.timeZone;
    // A job's note limits its tools and where it writes.
    const settings = task.job ? jobSettings(this.opts.vault, task.job) : undefined;
    const own: ToolHandler[] = [
      {
        def: {
          name: 'post_update',
          description: 'Post a short progress message to the owner in the channel the task came from. Use sparingly.',
          strict: true,
          input_schema: {
            type: 'object',
            properties: { text: { type: 'string' } },
            required: ['text'],
            additionalProperties: false,
          },
        },
        run: async (args) => {
          if (task.updates >= this.limits.updates) throw new Error('Update limit reached; save the rest for the final report.');
          const text = String(args.text ?? '').trim();
          if (!text) throw new Error('Empty update.');
          task.updates += 1;
          task.lastUpdate = text;
          await this.safePost(task.channelId, `🧩 **${task.title}** · ${text}`, false);
          return 'Posted.';
        },
      },
      {
        def: {
          name: 'wait_until',
          description:
            'Pause this task and resume at a later time, e.g. to check a price again tomorrow. ' +
            'Everything so far is kept. Must be before the deadline.',
          strict: true,
          input_schema: {
            type: 'object',
            properties: {
              at: { type: 'string', description: 'When to resume, ISO 8601 with UTC offset.' },
              reason: { type: 'string', description: 'What you will do then, in a few words.' },
            },
            required: ['at', 'reason'],
            additionalProperties: false,
          },
        },
        // Handled by the run loop, which has to stop when this is called.
        run: () => 'unused',
      },
      {
        def: {
          name: 'finish_task',
          description: 'End the task and send the owner the final report. Call as soon as the done-when condition is met.',
          strict: true,
          input_schema: {
            type: 'object',
            properties: {
              outcome: { type: 'string', enum: ['done', 'gave_up'] },
              report: { type: 'string', description: 'The message the owner will read.' },
            },
            required: ['outcome', 'report'],
            additionalProperties: false,
          },
        },
        run: () => 'unused',
      },
    ];
    const handlers = [
      ...own,
      // Shadow mode changes nothing outside the task's own note: no reminders, no memory.
      ...(task.shadow ? [] : reminderTools(this.opts.reminders, tz, task.channelId, task.channelName)),
      ...(this.opts.memory && !task.shadow ? memoryTools(this.opts.memory).filter((h) => h.def.name === 'remember') : []),
      // Read-only: a worker acts unattended on whatever the emails say.
      ...(this.opts.google ? googleTools(this.opts.google, tz, { readOnly: true }) : []),
      ...(this.opts.places ? placesTools(this.opts.places, tz, { readOnly: true }) : []),
      // Tasks are often "research this and write it up as a note"; moving and
      // deleting stay with the chat assistant, where the owner sees them.
      ...(this.opts.vault ? notesTools(this.opts.vault, tz, this.opts.reads, { sourceTask: task.note ? wikiLink(task.note) : undefined, writePaths: settings?.writePaths, job: task.job, ...(task.shadow ? { propose: (p: ProposedNote) => this.propose(task, p) } : {}) }).filter((h) => TASK_NOTE_TOOLS.includes(h.def.name)) : []),
      // fetch_page only: tasks run with no Discord message to read links from.
      ...linkTools(),
      ...(task.job && (JOBS[task.job]?.video || jobSettings(this.opts.vault, task.job).tools.includes('watch_video')) ? videoTools() : []),
    ].filter((h) => toolAllowed(settings, h.def.name));
    return { tools: handlers.map((h) => h.def), handlers: toolMap(handlers) };
  }

  private async run(task: Task) {
    const tz = this.opts.timeZone;
    const now = () => new Date();
    const deadline = new Date(task.deadline);
    const pastDeadline = () => now() >= deadline;
    const deadlineNote = () => (pastDeadline() ? 'The deadline has passed. Call finish_task now with what you have.' : undefined);

    task.status = 'running';
    if (task.messages.length === 0) {
      task.messages.push({
        role: 'user',
        content: [
          {
            type: 'text',
            text:
              `Task: ${task.title}\n` +
              `Goal: ${task.goal}\n` +
              `Done when: ${task.doneWhen}\n` +
              `Deadline: ${toLocalShort(deadline, tz)} (${toLocalIso(deadline, tz)})\n` +
              `Now: ${toLocalIso(now(), tz)} (owner's time zone ${tz})\n` +
              `Requested in: #${task.channelName}`,
          },
        ],
      });
    } else if (task.pending) {
      task.messages.push({
        role: 'tool',
        results: [...task.pending.results, { callId: task.pending.waitId, name: 'wait_until', content: `Resumed at ${toLocalIso(now(), tz)}.` }],
        note: deadlineNote(),
      });
      delete task.pending;
    } else {
      // Interrupted by a restart between asking for tools and answering them:
      // the conversation can't continue until every call has a result.
      const last = task.messages.at(-1);
      if (last?.role === 'assistant' && last.calls?.length) {
        task.messages.push({
          role: 'tool',
          results: last.calls.map((c) => ({
            callId: c.id,
            name: c.name,
            content: 'Interrupted by a restart before this ran. Call it again if it is still needed.',
            isError: true,
          })),
        });
      }
    }
    this.store.save();

    const { tools, handlers } = this.tools(task);
    let nudges = 0;
    for (let round = 0; round < this.limits.roundsPerRun; round++) {
      if (task.status !== 'running') return; // cancelled meanwhile
      if (task.apiCalls >= this.limits.totalCalls) return this.end(task, 'failed', 'Hit its limit of API calls before finishing.');
      if (now().getTime() > deadline.getTime() + DEADLINE_GRACE_MS) {
        return this.end(task, 'failed', 'Ran past its deadline without reporting back.');
      }
      const capped = task.job ? overCap(this.opts.vault, this.opts.activity, task.job, this.opts.timeZone, now(), task.usage) : undefined;
      if (capped) return this.end(task, 'failed', `Stopped: ${capped}`);

      let gen: Generation;
      try {
        gen = await this.opts.llm.generate(this.modelFor(task), {
          system: this.systemFor(task) + (this.opts.style?.prompt() ?? '') + (this.opts.memory?.prompt() ?? '') + (this.opts.journal?.prompt(this.opts.timeZone) ?? ''),
          tools,
          turns: task.messages,
          web: { maxUses: webAllowed(task.job ? jobSettings(this.opts.vault, task.job) : undefined) ? 10 : 0, location: this.opts.profile?.location },
        });
        task.apiCalls += 1;
        task.errors = 0;
        this.opts.reads?.recordFetches(gen);
        if (gen.usage) task.usage = task.usage ? addUsage(task.usage, gen.usage) : gen.usage;
      } catch (err) {
        return this.onError(task, err);
      }
      if (task.status !== 'running') return; // cancelled while the call was in flight

      if (gen.stop === 'refusal') return this.end(task, 'failed', 'The model declined to do this task.');
      task.messages.push(gen.turn);
      if (gen.stop === 'pause') {
        this.store.save();
        continue;
      }

      const { calls } = gen;
      if (calls.length === 0) {
        if (++nudges > 2) return this.end(task, 'failed', gen.text.trim() || 'Stopped without reporting.');
        const note = deadlineNote();
        task.messages.push({
          role: 'user',
          content: [{ type: 'text', text: `Keep going with a tool call, or end with wait_until or finish_task.${note ? ` ${note}` : ''}` }],
        });
        this.store.save();
        continue;
      }

      const results = await runTools(calls, handlers, new Set(['wait_until', 'finish_task']));
      this.opts.reads?.recordTools(calls, results);
      // The note it saved is what it produced; the task's note links to it.
      const saved = results
        .filter((r) => r.name === 'save_note' && !r.isError)
        .map((r) => /^(?:Saved|Replaced|Appended to) (.+\.md)\.$/.exec(r.content)?.[1])
        .filter((p): p is string => !!p)
        .at(-1);
      if (saved && saved !== task.output) {
        task.output = saved;
        this.writeNote(task);
      }
      const trace = { outcome: 'ok', calls: 0, tools: task.toolLog ?? [] };
      traceTools(trace, results);
      task.toolLog = trace.tools.slice(-MAX_TOOL_LOG);

      const finish = calls.find((c) => c.name === 'finish_task');
      if (finish) {
        const input = finish.input as { outcome?: string; report?: string };
        const report = `${String(input.report ?? '').trim() || '(no report)'}${gen.sources.footer()}`;
        return this.end(task, input.outcome === 'gave_up' ? 'gave_up' : 'done', report);
      }

      const wait = calls.find((c) => c.name === 'wait_until');
      if (wait) {
        const input = wait.input as { at?: string; reason?: string };
        const at = new Date(String(input.at));
        const problem = Number.isNaN(at.getTime())
          ? `Could not read "${input.at}" as a date and time.`
          : at > deadline
            ? `That is after the deadline (${toLocalIso(deadline, tz)}). Finish now, or wait until no later than the deadline.`
            : at.getTime() < now().getTime() + 60_000
              ? 'Pick a time at least a minute from now.'
              : null;
        if (!problem) {
          task.pending = { waitId: wait.id, results };
          task.status = 'waiting';
          task.wakeAt = at.toISOString();
          task.waitReason = String(input.reason ?? '');
          this.store.save();
          return;
        }
        results.push({ callId: wait.id, name: 'wait_until', content: problem, isError: true });
      }

      task.messages.push({ role: 'tool', results, note: deadlineNote() });
      this.store.save();
    }

    // A long stretch of work with no wait or finish: take a short break
    // rather than spin, unless it is out of time.
    if (pastDeadline()) return this.end(task, 'failed', 'Ran out of time before finishing.');
    task.messages.push({
      role: 'user',
      content: [{ type: 'text', text: 'That was a long stretch of work. Wrap up soon: finish_task if you can, or wait_until if you are waiting on something.' }],
    });
    task.status = 'queued';
    task.wakeAt = new Date(now().getTime() + RETRY_AFTER_ERROR_MS).toISOString();
    this.store.save();
  }

  private onError(task: Task, err: unknown) {
    task.errors += 1;
    console.error(`[task ${task.id}] API call failed (${task.errors}/${MAX_ERRORS}):`, err);
    const retryable = this.opts.llm.retryable(err);
    if (!retryable || task.errors >= MAX_ERRORS) {
      return this.end(task, 'failed', `Stopped after an error: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`);
    }
    task.status = 'queued';
    task.wakeAt = new Date(Date.now() + RETRY_AFTER_ERROR_MS).toISOString();
    this.store.save();
  }

  private end(task: Task, status: Exclude<TaskStatus, 'queued' | 'running' | 'waiting'>, report: string) {
    task.status = status;
    task.result = report;
    task.finishedAt = new Date().toISOString();
    delete task.wakeAt;
    this.opts.activity?.record({
      kind: 'task',
      outcome: status === 'done' ? 'ok' : status,
      channel: task.channelName,
      title: task.title,
      taskId: task.id,
      ...(task.job ? { job: task.job } : {}),
      ...(status === 'failed' ? { error: report.slice(0, 300) } : {}),
      ms: new Date(task.finishedAt).getTime() - new Date(task.createdAt).getTime(),
      calls: task.apiCalls,
      tools: task.toolLog,
      usage: task.usage,
    });
    delete task.toolLog;
    this.store.save();
    // The note shows how it ended: done, or failed with the outcome saying why.
    const note = this.writeNote(task);
    const icon = { done: '✅', gave_up: '🤷', cancelled: '🛑', failed: '⚠️' }[status];
    const label = { done: 'done', gave_up: 'couldn\'t finish', cancelled: 'cancelled', failed: 'stopped' }[status];
    // A cancel came from the owner, who already knows; don't ping for it.
    void this.safePost(task.channelId, `${icon} **${task.title}** — ${label}\n${report}${task.proposal ? `\n-# Shadow mode: proposed ${task.proposal.path}, not saved. Say "promote" to save it.` : ''}${note && status !== 'cancelled' ? `\n-# Saved to ${note}` : ''}`, status !== 'cancelled');
  }

  private async safePost(channelId: string, content: string, ping: boolean) {
    try {
      await this.post(channelId, content, ping);
    } catch (err) {
      console.error(`[tasks] could not post to ${channelId}:`, err);
    }
  }
}

/** The jobs a task can run: built-in task jobs and config-only ones, not the bot's own code steps. */
const taskJobs = (vault: Vault | undefined) => jobNames(vault).filter((j) => jobSettings(vault, j).kind === 'task');

/** The tools the chat assistant uses to hand off, check on, and stop tasks. */
export function taskTools(runner: TaskRunner, timeZone: string, channelId: string, channelName: string): ToolHandler[] {
  return [
    {
      def: {
        name: 'start_task',
        description:
          'Hand a job to a background worker that keeps going after you reply, for as long as the job needs ' +
          '(up to its deadline) and reports back in this channel when it is done. Use it for multi-step research, ' +
          'comparisons, planning, or watching something over time ("tell me when flights to Tokyo drop under $800"). ' +
          'Answer quick questions yourself instead. The worker sees none of this conversation, so the goal must ' +
          'carry every detail it needs (dates, places, budget, preferences). Every task needs an explicit end point.',
        strict: true,
        input_schema: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'A few words naming the task, shown on its messages.' },
            goal: { type: 'string', description: 'Everything the worker needs to know to do the job, self-contained.' },
            done_when: {
              type: 'string',
              description: 'The concrete condition that ends the task, e.g. "a shortlist of 3 hotels under $200/night with links" or "the price falls below $800, or the deadline passes".',
            },
            deadline: {
              type: 'string',
              description: 'Latest time the task may run, ISO 8601 with UTC offset. Pick one that fits the job: minutes to hours for research, days for watching something.',
            },
            job: {
              type: 'string',
              enum: ['none', ...taskJobs(runner.vault)],
              description: '"recipe" for turning a recipe reel, video or link into a Recipes note; "research" for research, comparisons and trip planning; another job when the owner names it; "none" for watching something over time and anything else.',
            },
            prompt: {
              type: 'string',
              description: 'Only when the owner names a prompt version for the job, e.g. "recipe v2"; otherwise empty.',
            },
            tier: {
              type: 'string',
              enum: TIERS,
              description:
                '"capable" (a stronger, slower model) for research, comparison, planning, reading long pages, or anything needing judgment. ' +
                '"fast" (the quick model) only for simple, mechanical jobs like re-checking one number on one page until it crosses a threshold.',
            },
          },
          required: ['title', 'goal', 'done_when', 'deadline', 'job', 'prompt', 'tier'],
          additionalProperties: false,
        },
      },
      run(args) {
        const task = runner.start({
          title: String(args.title ?? ''),
          goal: String(args.goal ?? ''),
          doneWhen: String(args.done_when ?? ''),
          deadline: new Date(String(args.deadline)),
          tier: TIERS.includes(args.tier as TaskTier) ? (args.tier as TaskTier) : 'capable',
          channelId,
          channelName,
          job: taskJobs(runner.vault).includes(String(args.job)) ? String(args.job) : undefined,
          prompt: String(args.prompt ?? '').trim() || undefined,
        });
        return `Started ${task.tier} ${task.job ? `${task.job} job (prompt ${task.prompt}) ` : ''}task ${task.id} "${task.title}", deadline ${toLocalShort(new Date(task.deadline), timeZone)}. It will report back in #${channelName}.`;
      },
    },
    {
      def: {
        name: 'list_tasks',
        description: 'List background tasks: unfinished ones and the most recent finished ones, with status and latest news.',
        strict: true,
        input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
      },
      run() {
        const all = runner.list();
        if (all.length === 0) return 'No tasks.';
        return all
          .map((t) => {
            const when =
              t.status === 'waiting' && t.wakeAt
                ? `, next check ${toLocalShort(new Date(t.wakeAt), timeZone)} (${t.waitReason ?? ''})`
                : '';
            const news = t.result ? ` · result: ${t.result.slice(0, 300)}` : t.lastUpdate ? ` · latest: ${t.lastUpdate}` : '';
            return `${t.id} · ${t.title} · ${t.status}${when} · deadline ${toLocalShort(new Date(t.deadline), timeZone)} · <#${t.channelId}>${news}`;
          })
          .join('\n');
      },
    },
    {
      def: {
        name: 'promote_task',
        description:
          'Save the note a shadow-mode factory task proposed (its report says "proposed … not saved") into the vault, when the owner approves it ("promote", "save it", "looks good"). ' +
          'Give the task id or a word from its title; empty for the latest proposal.',
        strict: true,
        input_schema: {
          type: 'object',
          properties: { task: { type: 'string', description: 'Task id or a word from its title; empty string for the latest.' } },
          required: ['task'],
          additionalProperties: false,
        },
      },
      run(args) {
        return runner.promote(String(args.task ?? ''));
      },
    },
    {
      def: {
        name: 'cancel_task',
        description: 'Stop an unfinished background task by id.',
        strict: true,
        input_schema: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
          additionalProperties: false,
        },
      },
      run(args) {
        const t = runner.cancel(String(args.id ?? ''));
        return `Cancelled ${t.id} "${t.title}".`;
      },
    },
  ];
}
