import { profilePrompt, runTools, Sources, toolMap, type LLM, type ModelOptions, type OwnerProfile, type Turn } from './llm.js';
import type { ReminderStore } from './reminders.js';
import { reminderTools } from './reminderTools.js';
import { taskTools, type TaskRunner } from './tasks.js';
import { MEMORY_PROMPT, memoryTools, type MemoryStore } from './memory.js';
import { TRAINING_PROMPT, trainingTools } from './trainingTools.js';
import { GOOGLE_PROMPT, googleTools, mailboxPrompt, type GoogleAccount } from './google.js';
import { NOTES_PROMPT, notesTools } from './notes.js';
import { SYNC_PROMPT, SYNC_STATUS } from './sync.js';
import type { ReadLog } from './readLog.js';
import { placesPrompt, placesTools } from './placesTools.js';
import type { SavedPlaces } from './places.js';
import { LINKS_PROMPT, linkTools, type DiscordReader } from './linkTools.js';
import { VIDEO_PROMPT, videoTools } from './video.js';
import type { TrainingService } from '../training/service.js';
import type { Vault } from '../../vault.js';
import { formatEntry, JOURNAL_PROMPT, journalTools, type Journal } from './journal.js';
import { traceTools, type Trace } from './activity.js';
import { BRIEF_PROMPT, briefTools, type BriefState } from './brief.js';
import { addUsage } from './usage.js';
import { ALL_GROUPS, channelGroups, groupsKey, missingGroupsNote, type ChannelToolsConfig, type ToolGroup } from './channelTools.js';
import { expenseTools, photoPrompt } from './photo.js';
import { FACTORY_POINTER } from './factoryGuard.js';
import { codeJobPrompt } from './codeJobs.js';
import { SEMANTIC_PROMPT, semanticTools, type SemanticIndex } from './semantic.js';
import type { StyleStore } from './style.js';

export type { Effort } from './llm.js';

export interface AgentOptions extends ModelOptions {
  llm: LLM;
  timeZone: string;
  reminders: ReminderStore;
  /** Background tasks; without it the assistant has no start_task tool. */
  tasks?: TaskRunner;
  profile?: OwnerProfile;
  /** Long-term memory; read into every reply, written by the model. */
  memory?: MemoryStore;
  /** The training log; gives the assistant read and log access to it. */
  training?: TrainingService;
  /** The owner's Gmail and Google Calendar. */
  google?: GoogleAccount;
  /** The owner's Obsidian vault: search and read all of it, organise its notes and folders. */
  vault?: Vault;
  /** Pages and videos actually opened; recipe notes may only cite these. */
  reads?: ReadLog;
  /** The owner's saved Google Maps lists. */
  places?: SavedPlaces;
  /** Summaries of earlier conversations, so replies pick up where things were left. */
  journal?: Journal;
  /** The morning brief's state, so the owner can drop items from it in chat. */
  brief?: BriefState;
  /** Search by meaning over notes and the journal, from a local embedding model. */
  semantic?: SemanticIndex;
  /** Which tool groups each channel gets; without it, every channel gets everything. */
  channelTools?: ChannelToolsConfig;
  /** How the owner writes, from their own messages; replies are written in that voice. */
  style?: StyleStore;
}

export interface TurnContext {
  channelId: string;
  channelName: string;
  /** The Discord category the channel sits in, which decides its tools. */
  categoryName?: string;
  /** Opens Discord message links; without it there is no read_discord_messages tool. */
  discord?: DiscordReader;
  /** Filled in with the API calls, tools and usage of this reply, for the activity log. */
  trace?: Trace;
}

// Most tool rounds a single reply may take. Each search or reminder call is
// one round; this only stops a runaway loop.
const MAX_ROUNDS = 10;

const SYSTEM = `You're Squire, your owner's personal assistant in their Discord server. It's just the two of you, across a few channels named for what they're for (#gym, #travel, #recipes, #misc, #dev and so on). Let the channel shape the answer.

Voice:
- Text like a sharp friend who's got their back: casual, contractions, plain words, lowercase is fine. No chatbot filler ("Certainly!", "Great question", "Hope this helps", "Let me know if you need anything else").
- Lead with the answer. Most replies are a sentence or two; use a list only for several real items, and go long only when they ask.
- One caveat at most, only if it changes what they'd do, and don't repeat one you've already given in this chat.
- Got something wrong? Fix it in a few words and move on. No long apology or recap.
- Use US units by default: miles, feet, °F, pounds, ounces, cups, mph. Convert anything a source gives in metric ("about 3 miles"), unless they ask for metric or it's a recipe's own measurements.
- Discord renders **bold**, *italics*, bullet lists, \`code\` and code blocks, but not tables or # headings, so skip those.

Reading the chat:
- Each of their messages starts with a stamp like "[Thu 12 Nov, 13:51 · #gym]": their local time and channel. Use it for anything relative ("tomorrow", "in 20 minutes") and never echo it.
- Messages starting with ⏰, 🧩, ✅, 🤷, 🛑 or ⚠️ came from your reminders and background tasks.
- Your earlier replies were backed by tool calls you can't see now (reminders set, pages read, tasks run). Don't take one back as made up or undone unless a check now (list_reminders, list_tasks, opening it again) shows it didn't happen.

Doing things:
- When they ask for something, do it in this reply instead of offering to ("want me to...?"). Ask only when the choice is really theirs or the ask is truly ambiguous.
- For should-I, is-it-worth-it and what-do-you-think questions, or a plan they're weighing ("should I get storage if I shop a lot?", "is it worth renting a car in Kyoto?"), work out what the answer hinges on and look all of it up first: the options, their prices, sizes, hours and locations, and what their own bookings allow (check their calendar, email or notes, then that place's policy). Then give a clear pick with the specifics behind it, still short. Research changes how sure you sound, not how long you go on.
- Skip lookups for small talk, things you know well, or when they want your quick take.
- Never say you haven't checked something you could check now. Check it.
- Never say you checked, found, saved or confirmed something unless a tool did it in this reply; if it's from earlier in the chat, say so or look again. Only cite pages a tool actually returned, and never write a link you didn't get from a tool. If something can't be found, say so in a few words ("couldn't find current locker prices").

Tools:
- Search the web for anything current, local or uncertain: hours, prices, news, flights, weather, docs. Open pages they link or that a search turns up rather than guessing what they say, and run several searches when a question has several parts.
- After a lookup, text the bottom line: "high of 59, maybe showers, bring a jacket". Don't walk through the sources; links get added under your reply automatically. Mention a disagreement only if it changes what they should do.
- Use the reminder tools whenever they want to be reminded or nudged later, or ask what's coming up. Reminders post in the channel they were set in and ping your owner. Write the text as the message they'll see then ("Leave for the airport, UA123 at 18:40"), not as a note to yourself. If it is about a note or recipe, name that note by title and point to it ("Make the ube muffins: see Recipes/Pastries/Coconut Cheesecake Ube Muffins"); don't copy its details into the reminder.
- Set reminders without asking unless the time is genuinely ambiguous, and confirm in one line with the local day and time. Same when you cancel one.`;

const TASKS_PROMPT = `
Background tasks:
- start_task hands a job to a worker that keeps going after you reply and reports back in the channel. Use it for jobs that need many searches or a lot of reading (trip plans, comparisons, digging through docs) or that play out over time (watching a price, waiting for an announcement). Handle anything you can do in one go yourself.
- Give every task a done_when someone could check and a deadline that fits. If the ask has no natural end ("keep an eye on flights"), pick one ("until it drops under $X or the 20th, whichever comes first") and tell them.
- The worker sees none of this chat, so put everything it needs in the goal, including what's settled: flights, dates, bookings made, preferences they've stated.
- Pick its job: "research" for research, comparisons and trip planning (the research factory, with its own instructions); "recipe" for a recipe link (see Recipe factory); "none" for watching something over time and anything else.
- After starting one, say in one line what it's doing and when it'll report back. Only say a task is running if you called start_task in this reply. Use list_tasks for progress and cancel_task to stop one.`;

/** In a channel with notes: links that are recipes go to the recipe factory, a background job with its own versioned instructions. */
const RECIPE_FACTORY_PROMPT = `
Recipe factory:
- A recipe reel, video, post or recipe page link shared with no other ask (in #recipes above all) goes to the recipe factory: call start_task with job "recipe", tier "capable", a deadline an hour out, title "<dish> recipe" (or "Recipe from link" when you can't tell), the goal holding the link and anything they said about it ("halve it", "file it under Sauce"), and done_when "a sourced recipe note for it is saved, or the report says why not". Don't open the link yourself first, and don't save the recipe yourself; reply in one line that it's on it.
- Recipes from a photo, recipes they type out, and changes to a recipe note they already have stay with you, as before. prompt stays empty unless they name a version ("use recipe v2").
- The factory may run in shadow mode: its report then proposes a note instead of saving it. When they approve one ("promote", "save it", "looks good"), call promote_task; if they want changes first, start the job again with what to change.`;

/** The text of the owner's latest message: what a note in Factory/ has to be named in before it is changed. */
function ownerText(conversation: Turn[]): string {
  const last = [...conversation].reverse().find((t) => t.role === 'user');
  return last && last.role === 'user' ? last.content.map((p) => (p.type === 'text' ? p.text : '')).join('\n') : '';
}

export class Agent {
  /** The system prompt for each set of tool groups, built once: the API caches it, so it must not change between messages. */
  private readonly systems = new Map<string, string>();

  constructor(private readonly opts: AgentOptions) {}

  /** The fixed system prompt for a channel's tool groups. */
  systemFor(groups: ReadonlySet<ToolGroup> = ALL_GROUPS): string {
    // The photo actions are the photo job's prompt note: a new production version changes the prompt.
    const photo = codeJobPrompt(this.opts.vault, 'photo');
    // So are the rules for logging sets from chat.
    const training = codeJobPrompt(this.opts.vault, 'training-log');
    const key = `${groupsKey(groups)}|${photo?.name ?? ''}|${training?.name ?? ''}`;
    const cached = this.systems.get(key);
    if (cached) return cached;
    const o = this.opts;
    const on = (g: ToolGroup) => groups.has(g);
    // The fixed part first and the memory list last, so a new memory only
    // invalidates the cached prompt from that point on.
    const system =
      `${SYSTEM}${o.tasks ? TASKS_PROMPT : ''}${o.memory ? MEMORY_PROMPT : ''}${o.journal ? JOURNAL_PROMPT : ''}${o.semantic ? SEMANTIC_PROMPT : ''}${o.brief ? BRIEF_PROMPT : ''}${o.training && on('training') ? (training ? `\n${training.text.trim()}` : TRAINING_PROMPT) : ''}` +
      `${o.google && on('google') ? GOOGLE_PROMPT + mailboxPrompt(o.google) : ''}${o.vault && on('notes') ? NOTES_PROMPT + FACTORY_POINTER + (o.vault.read(SYNC_STATUS) !== undefined ? `\n${SYNC_PROMPT}` : '') : ''}${o.vault && o.tasks && on('notes') ? RECIPE_FACTORY_PROMPT : ''}${o.places && on('places') ? placesPrompt(o.places) : ''}` +
      `${LINKS_PROMPT}${on('video') ? VIDEO_PROMPT : ''}${photoPrompt(this.available(groups), photo?.text)}${profilePrompt(o.profile)}${missingGroupsNote(groups)}\n\nOwner's time zone: ${o.timeZone}.`;
    this.systems.set(key, system);
    return system;
  }

  /** The groups both switched on for the channel and configured at all. */
  private available(groups: ReadonlySet<ToolGroup>): ReadonlySet<ToolGroup> {
    const o = this.opts;
    const configured: Record<ToolGroup, boolean> = { notes: !!o.vault, training: !!o.training, google: !!o.google, places: !!o.places, video: true, expenses: !!o.vault };
    return new Set([...groups].filter((g) => configured[g]));
  }

  /** The tool groups a channel gets. */
  groupsFor(channelName: string, categoryName?: string): ReadonlySet<ToolGroup> {
    return this.opts.channelTools ? channelGroups(channelName, categoryName, this.opts.channelTools) : ALL_GROUPS;
  }

  /** Runs one reply: the model, any tools it calls, until it has an answer. */
  async reply(conversation: Turn[], ctx: TurnContext): Promise<string> {
    const { llm, timeZone, reminders, tasks, google, vault, places, journal, semantic } = this.opts;
    const groups = this.groupsFor(ctx.channelName, ctx.categoryName);
    const on = (g: ToolGroup) => groups.has(g);
    const handlers = toolMap([
      ...reminderTools(reminders, timeZone, ctx.channelId, ctx.channelName),
      ...(tasks ? taskTools(tasks, timeZone, ctx.channelId, ctx.channelName) : []),
      ...(this.opts.memory ? memoryTools(this.opts.memory) : []),
      ...(this.opts.training && on('training') ? trainingTools(this.opts.training) : []),
      ...(google && on('google') ? googleTools(google, timeZone) : []),
      ...(vault && on('notes') ? notesTools(vault, timeZone, this.opts.reads, { ownerText: ownerText(conversation) }) : []),
      ...(vault && on('expenses') ? expenseTools(vault, timeZone) : []),
      ...(places && on('places') ? placesTools(places, timeZone) : []),
      ...(journal ? journalTools(journal, timeZone) : []),
      ...(semantic ? semanticTools(semantic, journal, timeZone) : []),
      ...(this.opts.brief ? briefTools(this.opts.brief) : []),
      ...linkTools(ctx.discord),
      ...(on('video') ? videoTools() : []),
    ]);
    const tools = [...handlers.values()].map((h) => h.def);
    const baseSystem = this.systemFor(groups);

    const keyworded = journal ? withRelated(conversation, journal, timeZone) : [...conversation];
    const turns = journal && semantic ? await withMeaning(keyworded, conversation, journal, semantic, timeZone) : keyworded;
    const sources = new Sources();
    let text = '';
    // Whether this reply saved to memory, and whether it has been told off once for not doing so.
    let saved = false;
    let nudged = false;
    // The same for details looked up and left in chat with an offer to add them to a note.
    let noted = false;
    let noteNudged = false;

    for (let round = 0; round < MAX_ROUNDS; round++) {
      // The voice changes weekly at most, memories and the journal more often, so it goes first.
      const system = baseSystem + (this.opts.style?.prompt() ?? '') + (this.opts.memory?.prompt() ?? '') + (journal?.prompt(timeZone) ?? '');
      const gen = await llm.generate(this.opts, { system, tools, turns, web: { maxUses: 8, location: this.opts.profile?.location } });
      if (ctx.trace) {
        ctx.trace.calls += 1;
        if (gen.usage) ctx.trace.usage = ctx.trace.usage ? addUsage(ctx.trace.usage, gen.usage) : gen.usage;
      }
      text += gen.text;
      sources.merge(gen.sources);
      this.opts.reads?.recordFetches(gen);

      if (gen.stop === 'refusal') {
        if (ctx.trace) ctx.trace.outcome = 'refused';
        return text || "Sorry, I can't help with that one.";
      }
      turns.push(gen.turn);
      if (gen.stop === 'pause') continue;
      if (gen.calls.some((c) => MEMORY_WRITES.has(c.name))) saved = true;
      if (gen.calls.some((c) => c.name === 'save_note')) noted = true;
      if (gen.stop !== 'tool_use') {
        // "Want me to add these to the note?" after looking them up leaves
        // them in chat. Send it back once to save them.
        if (handlers.has('save_note') && !noted && !noteNudged && round < MAX_ROUNDS - 1 && offersToSaveToNote(text)) {
          noteNudged = true;
          if (ctx.trace) ctx.trace.tools.push('note_nudge');
          turns.push({ role: 'user', content: [{ type: 'text', text: UNSAVED_NOTE }] });
          text = '';
          continue;
        }
        // "Got it, from now on…" with nothing saved is a promise that lasts
        // one conversation. Send it back once to save first.
        if (this.opts.memory && !saved && !nudged && round < MAX_ROUNDS - 1 && promisesToRemember(text)) {
          nudged = true;
          if (ctx.trace) ctx.trace.tools.push('memory_nudge');
          turns.push({ role: 'user', content: [{ type: 'text', text: UNSAVED_PROMISE }] });
          text = '';
          continue;
        }
        break;
      }

      const results = await runTools(gen.calls, handlers);
      this.opts.reads?.recordTools(gen.calls, results);
      if (ctx.trace) traceTools(ctx.trace, results);
      turns.push({ role: 'tool', results });
      if (round === MAX_ROUNDS - 1 && ctx.trace) ctx.trace.outcome = 'max_rounds';
      // Text before a tool call is narration ("let me check"); the answer is
      // what comes after.
      text = '';
    }

    return (text.trim() || "I couldn't come up with an answer to that — try asking another way?") + sources.footer();
  }
}

const MEMORY_WRITES = new Set(['remember', 'update_memory', 'forget_memory']);

/** Replies that promise to carry something into later conversations. */
const PROMISE =
  /\b(from now on|going forward|moving forward|in (the )?future|next time|i'?ll (remember|keep (that|this|it) in mind|always|stop|no longer|make sure)|i won'?t (remind|mention|bring|ask|suggest|do that)|noted\b|will do\b)/i;

export const promisesToRemember = (reply: string) => PROMISE.test(reply);

const UNSAVED_PROMISE =
  '[Squire system check, not from the owner] Your reply promises to carry this into later conversations, but you saved nothing to memory, and only memory carries over. If it is a standing preference or instruction, call remember (or update_memory the memory it changes) now, then give your reply again. If it is already in memory, or isn\'t a standing preference, give your reply again unchanged. Don\'t mention this check.';

/** Replies that offer to put something into a note, or say it isn't in one yet, instead of saving it. */
const NOTE_OFFER =
  /\b(want me to|should i|shall i|i can|i could|happy to|let me know if you want me to)\s+(also\s+)?(add|save|put|write|update|drop|stick|file)\b[^?!\n]{0,100}\b(note|notes|obsidian|vault)\b|\bnot (yet )?(saved|added) (to|in(to)?) the note\b|\b(aren'?t|isn'?t|not) in the note yet\b/i;

export const offersToSaveToNote = (reply: string) => NOTE_OFFER.test(reply);

const UNSAVED_NOTE =
  "[Squire system check, not from the owner] Your reply offers to put details into a note, or says they aren't in it yet, instead of saving them. The owner wants what you look up kept in their notes. Unless they said not to, read_note that note now and save_note it with the details added next to each item (mark guesses and unconfirmed ones), then give your reply again, saying in a few words that the note is updated. If there's no note it belongs in, or it's a choice the owner has to make first (which version of a recipe to save), give your reply again unchanged. Don't mention this check.";

/**
 * Older journal entries that share words with the owner's latest message, as
 * a note on that message. It goes on the turn rather than in the system
 * prompt so the cached prompt stays the same from one message to the next.
 */
export function withRelated(conversation: Turn[], journal: Journal, timeZone: string): Turn[] {
  const last = conversation.at(-1);
  if (last?.role !== 'user') return [...conversation];
  const text = last.content.map((p) => (p.type === 'text' ? p.text : '')).join(' ');
  const note = journal.related(text, timeZone);
  return note ? [...conversation.slice(0, -1), { role: 'user', content: [...last.content, { type: 'text', text: note }] }] : [...conversation];
}

/** How close a journal entry must be, by meaning, to ride along with a message unasked. Stricter than search. */
const RELATED_BY_MEANING = 0.62;
/** A related-by-meaning lookup slower than this is skipped, not waited on. */
const MEANING_TIMEOUT_MS = 2500;

/**
 * Up to two more older journal entries about the same thing as the owner's
 * latest message, though they share no words with it, as a note on that
 * message like the keyword matches. Any failure (Ollama down or slow) just
 * leaves them out.
 */
export async function withMeaning(turns: Turn[], original: Turn[], journal: Journal, semantic: SemanticIndex, timeZone: string, now = new Date()): Promise<Turn[]> {
  const last = original.at(-1);
  const lastTurn = turns.at(-1);
  if (last?.role !== 'user' || lastTurn?.role !== 'user') return turns;
  const text = last.content.map((p) => (p.type === 'text' ? p.text : '')).join(' ').trim();
  if (text.length < 12) return turns;
  const skip = new Set([...journal.standing(now).map((e) => e.id), ...journal.search(text, 3).map((e) => e.id)]);
  let timer: NodeJS.Timeout | undefined;
  const hits = await Promise.race([
    semantic.search(text, { scope: 'journal', limit: 2, exclude: skip }).catch(() => []),
    new Promise<[]>((r) => (timer = setTimeout(() => r([]), MEANING_TIMEOUT_MS))),
  ]).finally(() => clearTimeout(timer));
  const byId = new Map(journal.entries().map((e) => [e.id, e]));
  const entries = hits.filter((h) => h.score >= RELATED_BY_MEANING).map((h) => byId.get(h.ref)).filter((e): e is NonNullable<typeof e> => !!e);
  if (entries.length === 0) return turns;
  const note = `[Older conversations about something similar, from your journal:\n${entries.map((e) => formatEntry(e, timeZone)).join('\n')}]`;
  return [...turns.slice(0, -1), { role: 'user', content: [...lastTurn.content, { type: 'text', text: note }] }];
}
