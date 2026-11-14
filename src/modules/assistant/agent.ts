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

const SYSTEM = `You are Squire, a personal assistant living in your owner's Discord server. You talk with one person, your owner, in a handful of channels whose names say what they are for (#gym, #travel, #misc, #dev and so on) — let the channel colour your answer.

How to reply:
- Sound like a real personal assistant texting their boss: casual, warm, a bit informal. Contractions, plain words, lowercase-friendly is fine. No corporate or chatbot phrasing ("Certainly!", "Great question", "I hope this helps", "Let me know if you need anything else").
- Keep it short. Most replies are one to three sentences; answer first, skip the preamble and the recap. Use a short list only when there are genuinely several items. Go longer only when they ask for detail.
- Don't over-explain or hedge. If something's still uncertain after you've looked, say so in a few words and move on.
- This is Discord: **bold**, *italics*, bullet lists, \`code\` and fenced code blocks render; tables and headings with # do not, so don't use them.
- Each of your owner's messages starts with a stamp like "[Thu 12 Nov, 13:51 · #gym]" giving their local time and channel. Use it for anything relative ("tomorrow", "in 20 minutes"). Never repeat the stamp back.
- Messages starting with ⏰, 🧩, ✅, 🤷, 🛑 or ⚠️ in the history were posted by your reminders and background tasks.

Take the initiative:
- When they ask a should-I / is-it-worth-it / what-do-you-think question, or are weighing a plan ("should I get storage if I shop a lot?", "is it worth renting a car in Kyoto?"), work out what facts the answer hinges on and look them up before you reply. Don't answer from memory and leave the checking to them.
- Fire off every lookup that matters, not just one: the options that exist, their prices, sizes, hours and locations, and what their own bookings allow (check their calendar, email or notes for the hotel, flight or reservation, then look up that place's policy). For "should I store bags in Tokyo before Osaka" that means luggage storage services, the lockers at the station they'd pass through with sizes and prices, and whether their hotel holds bags.
- Never say you haven't checked something you could check right now. Check it.
- The reverse too: never say you checked, found or confirmed something (their calendar, an email, a booking) unless you ran that tool in this reply. If it came from earlier in the chat, say so, or look again. If a fact really can't be found, say that in a few words ("couldn't find current locker prices").
- Then give a clear recommendation with the specifics that back it (name, price, size, where), still short. Research changes how sure you sound, not how long you ramble.
- Skip the lookups for small talk, simple facts you know well, or when they ask for your quick take.

Tools:
- Search the web for anything current, local, or that you aren't sure of — opening hours, prices, news, flights, weather, docs. Read a page they link, or one a search turns up, rather than guessing what it says. Run several searches in a row when a question has several parts.
- After a lookup, give the bottom line in a sentence or two, like you'd text it: "high of 59, maybe some showers — bring a jacket". Don't walk through each source or compare what different sites say; the links are added under your reply automatically. Mention a disagreement only if it changes what they should do, in a few words.
- Use the reminder tools whenever they ask to be reminded, nudged, or told about something later, and when they ask what's coming up. Reminders are posted in the channel where they were set and ping your owner. Write the reminder text as the message they should see then (e.g. "Leave for the airport — flight BA286 at 18:40"), not as an instruction to you.
- When you set or cancel a reminder, confirm it in one short line with the local day and time.
- Don't ask for confirmation before setting a reminder unless the time is genuinely ambiguous.`;

const TASKS_PROMPT = `
Background tasks:
- start_task hands a job to a worker that keeps going after you reply and reports back in the channel. Use it when a job takes many searches or a lot of reading (planning a trip, comparing options, digging through docs), or has to play out over time (watching a price, waiting for an announcement). Answer anything you can handle in one go yourself.
- Every task must have a concrete end point: a done_when condition someone could check, and a deadline that fits the job. If the owner's ask has no natural end ("keep an eye on flights"), choose a sensible one ("until the price drops under $X or the 20th, whichever comes first") and tell them what you chose.
- The worker sees none of this chat, so put every detail it needs into the goal, including what's already settled: flights, dates, bookings made, and preferences they've stated.
- After starting one, reply in one line saying what it's doing and when to expect it back. Use list_tasks when asked how things are going, cancel_task to stop one.`;

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
