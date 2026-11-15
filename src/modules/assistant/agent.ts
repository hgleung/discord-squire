import { profilePrompt, runTools, Sources, toolMap, type LLM, type ModelOptions, type OwnerProfile, type Turn } from './llm.js';
import type { ReminderStore } from './reminders.js';
import { reminderTools } from './reminderTools.js';
import { taskTools, type TaskRunner } from './tasks.js';
import { MEMORY_PROMPT, memoryTools, type MemoryStore } from './memory.js';
import { TRAINING_PROMPT, trainingTools } from './trainingTools.js';
import { GOOGLE_PROMPT, googleTools, type GoogleAccount } from './google.js';
import { NOTES_PROMPT, notesTools } from './notes.js';
import { placesPrompt, placesTools } from './placesTools.js';
import type { SavedPlaces } from './places.js';
import { LINKS_PROMPT, linkTools, type DiscordReader } from './linkTools.js';
import { VIDEO_PROMPT, videoTools } from './video.js';
import type { TrainingService } from '../training/service.js';
import type { Vault } from '../../vault.js';

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
  /** The owner's Obsidian vault: search and read all of it, organise notes and folders under Squire. */
  vault?: Vault;
  /** The owner's saved Google Maps lists. */
  places?: SavedPlaces;
}

export interface TurnContext {
  channelId: string;
  channelName: string;
  /** Opens Discord message links; without it there is no read_discord_messages tool. */
  discord?: DiscordReader;
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
- Use the reminder tools whenever they want to be reminded or nudged later, or ask what's coming up. Reminders post in the channel they were set in and ping your owner. Write the text as the message they'll see then ("Leave for the airport, BA286 at 18:40"), not as a note to yourself.
- Set reminders without asking unless the time is genuinely ambiguous, and confirm in one line with the local day and time. Same when you cancel one.`;

const TASKS_PROMPT = `
Background tasks:
- start_task hands a job to a worker that keeps going after you reply and reports back in the channel. Use it for jobs that need many searches or a lot of reading (trip plans, comparisons, digging through docs) or that play out over time (watching a price, waiting for an announcement). Handle anything you can do in one go yourself.
- Give every task a done_when someone could check and a deadline that fits. If the ask has no natural end ("keep an eye on flights"), pick one ("until it drops under $X or the 20th, whichever comes first") and tell them.
- The worker sees none of this chat, so put everything it needs in the goal, including what's settled: flights, dates, bookings made, preferences they've stated.
- After starting one, say in one line what it's doing and when it'll report back. Only say a task is running if you called start_task in this reply. Use list_tasks for progress and cancel_task to stop one.`;

export class Agent {
  private readonly system: string;

  constructor(private readonly opts: AgentOptions) {
    // The fixed part first and the memory list last, so a new memory only
    // invalidates the cached prompt from that point on.
    this.system =
      `${SYSTEM}${opts.tasks ? TASKS_PROMPT : ''}${opts.memory ? MEMORY_PROMPT : ''}${opts.training ? TRAINING_PROMPT : ''}` +
      `${opts.google ? GOOGLE_PROMPT : ''}${opts.vault ? NOTES_PROMPT : ''}${opts.places ? placesPrompt(opts.places) : ''}` +
      `${LINKS_PROMPT}${VIDEO_PROMPT}${profilePrompt(opts.profile)}\n\nOwner's time zone: ${opts.timeZone}.`;
  }

  /** Runs one reply: the model, any tools it calls, until it has an answer. */
  async reply(conversation: Turn[], ctx: TurnContext): Promise<string> {
    const { llm, timeZone, reminders, tasks, google, vault, places } = this.opts;
    const handlers = toolMap([
      ...reminderTools(reminders, timeZone, ctx.channelId, ctx.channelName),
      ...(tasks ? taskTools(tasks, timeZone, ctx.channelId, ctx.channelName) : []),
      ...(this.opts.memory ? memoryTools(this.opts.memory) : []),
      ...(this.opts.training ? trainingTools(this.opts.training) : []),
      ...(google ? googleTools(google, timeZone) : []),
      ...(vault ? notesTools(vault, timeZone) : []),
      ...(places ? placesTools(places, timeZone) : []),
      ...linkTools(ctx.discord),
      ...videoTools(),
    ]);
    const tools = [...handlers.values()].map((h) => h.def);

    const turns = [...conversation];
    const sources = new Sources();
    let text = '';

    for (let round = 0; round < MAX_ROUNDS; round++) {
      const system = this.system + (this.opts.memory?.prompt() ?? '');
      const gen = await llm.generate(this.opts, { system, tools, turns, web: { maxUses: 8, location: this.opts.profile?.location } });
      text += gen.text;
      sources.merge(gen.sources);

      if (gen.stop === 'refusal') return text || "Sorry, I can't help with that one.";
      turns.push(gen.turn);
      if (gen.stop === 'pause') continue;
      if (gen.stop !== 'tool_use') break;

      turns.push({ role: 'tool', results: await runTools(gen.calls, handlers) });
      // Text before a tool call is narration ("let me check"); the answer is
      // what comes after.
      text = '';
    }

    return (text.trim() || "I couldn't come up with an answer to that — try asking another way?") + sources.footer();
  }
}
