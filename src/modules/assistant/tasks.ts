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
import { NOTES_TASK_PROMPT, notesTools, saveTaskReport, TASK_NOTE_TOOLS } from './notes.js';
import type { Vault } from '../../vault.js';
import { placesPrompt, placesTools } from './placesTools.js';
import { linkTools } from './linkTools.js';
import type { SavedPlaces } from './places.js';
import type { Journal } from './journal.js';
import { traceTools, type ActivityLog } from './activity.js';
import { addUsage } from './usage.js';
import type { Usage } from './llm.js';
import type { ReadLog } from './readLog.js';

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
}

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
- Your finish_task report is what the owner reads: it is posted in the channel the task came from, with a ping, so that is your reply there. Don't tell them you can't post. Lead with the answer. Keep it tight: it's a Discord message, so bullets and **bold** work, tables and # headings don't. Include links for anything they'd act on.
- Every turn must end in a tool call: keep working, wait_until, or finish_task.`;

export class TaskRunner {
  private readonly running = new Set<string>();
  private readonly limits: TaskLimits;
  private readonly effort: Effort;
  private readonly system: string;
  private post: Poster = async () => {};

  constructor(
    private readonly store: TaskStore,
    private readonly opts: TaskRunnerOptions,
  ) {
    this.limits = { ...DEFAULT_LIMITS, ...opts.limits };
    // Tasks are the multi-step work, so they think at least at medium.
    const order: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
    const effort = order.indexOf(opts.effort) < 1 ? 'medium' : opts.effort;
    this.effort = effort;
    this.system =
      SYSTEM +
      (opts.memory ? '\n- If you learn something durable about the owner that would help later (a preference, a plan, a constraint), save it with remember.' : '') +
      (opts.google ? GOOGLE_TASK_PROMPT + mailboxPrompt(opts.google) : '') +
      (opts.places ? placesPrompt(opts.places, { readOnly: true }) : '') +
      (opts.vault ? NOTES_TASK_PROMPT : '') +
      '\n- If web_fetch fails on a page or comes back blocked, try fetch_page on the same link before giving up on it.' +
      profilePrompt(opts.profile);
    // A task that was mid-run when the bot stopped picks up where it left off.
    for (const t of store.all()) {
      if (t.status === 'running') {
        t.status = 'queued';
        t.wakeAt = new Date().toISOString();
      }
    }
  }

  /** Where tasks post; set once Discord is connected. */
  setPoster(post: Poster) {
    this.post = post;
  }

  list(): Task[] {
    return this.store.all();
  }

  active(): Task[] {
    return this.store.all().filter((t) => ACTIVE.includes(t.status));
  }

  private modelFor(task: Task): ModelOptions {
    return { model: task.tier === 'fast' ? this.opts.fastModel : this.opts.model, effort: this.effort };
  }

  start(
    input: { title: string; goal: string; doneWhen: string; deadline: Date; tier?: TaskTier; channelId: string; channelName: string },
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
    };
    this.store.add(task);
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

  private tools(task: Task): { tools: ToolDef[]; handlers: Map<string, ToolHandler> } {
    const tz = this.opts.timeZone;
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
      ...reminderTools(this.opts.reminders, tz, task.channelId, task.channelName),
      ...(this.opts.memory ? memoryTools(this.opts.memory).filter((h) => h.def.name === 'remember') : []),
      // Read-only: a worker acts unattended on whatever the emails say.
      ...(this.opts.google ? googleTools(this.opts.google, tz, { readOnly: true }) : []),
      ...(this.opts.places ? placesTools(this.opts.places, tz, { readOnly: true }) : []),
      // Tasks are often "research this and write it up as a note"; moving and
      // deleting stay with the chat assistant, where the owner sees them.
      ...(this.opts.vault ? notesTools(this.opts.vault, tz, this.opts.reads).filter((h) => TASK_NOTE_TOOLS.includes(h.def.name)) : []),
      // fetch_page only: tasks run with no Discord message to read links from.
      ...linkTools(),
    ];
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

      let gen: Generation;
      try {
        gen = await this.opts.llm.generate(this.modelFor(task), {
          system: this.system + (this.opts.memory?.prompt() ?? '') + (this.opts.journal?.prompt(this.opts.timeZone) ?? ''),
          tools,
          turns: task.messages,
          web: { maxUses: 10, location: this.opts.profile?.location },
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
      ...(status === 'failed' ? { error: report.slice(0, 300) } : {}),
      ms: new Date(task.finishedAt).getTime() - new Date(task.createdAt).getTime(),
      calls: task.apiCalls,
      tools: task.toolLog,
      usage: task.usage,
    });
    delete task.toolLog;
    this.store.save();
    // Real results become notes; a cancel or a crash has nothing worth keeping.
    const note = this.opts.vault && (status === 'done' || status === 'gave_up') ? saveTaskReport(this.opts.vault, task, this.opts.timeZone) : undefined;
    const icon = { done: '✅', gave_up: '🤷', cancelled: '🛑', failed: '⚠️' }[status];
    const label = { done: 'done', gave_up: 'couldn\'t finish', cancelled: 'cancelled', failed: 'stopped' }[status];
    // A cancel came from the owner, who already knows; don't ping for it.
    void this.safePost(task.channelId, `${icon} **${task.title}** — ${label}\n${report}${note ? `\n-# Saved to ${note}` : ''}`, status !== 'cancelled');
  }

  private async safePost(channelId: string, content: string, ping: boolean) {
    try {
      await this.post(channelId, content, ping);
    } catch (err) {
      console.error(`[tasks] could not post to ${channelId}:`, err);
    }
  }
}

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
            tier: {
              type: 'string',
              enum: TIERS,
              description:
                '"capable" (a stronger, slower model) for research, comparison, planning, reading long pages, or anything needing judgment. ' +
                '"fast" (the quick model) only for simple, mechanical jobs like re-checking one number on one page until it crosses a threshold.',
            },
          },
          required: ['title', 'goal', 'done_when', 'deadline', 'tier'],
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
        });
        return `Started ${task.tier} task ${task.id} "${task.title}", deadline ${toLocalShort(new Date(task.deadline), timeZone)}. It will report back in #${channelName}.`;
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
