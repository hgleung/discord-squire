import {
  ActionRowBuilder,
  ApplicationCommandType,
  ContextMenuCommandBuilder,
  GatewayIntentBits,
  MessageFlags,
  ModalBuilder,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import type { ChatInputCommandInteraction, Client, Message, MessageContextMenuCommandInteraction, ModalSubmitInteraction } from 'discord.js';
import type { BotModule } from '../types.js';
import { Agent, type Effort } from './agent.js';
import type { ModelOptions, OwnerProfile } from './llm.js';
import { EFFORTS } from './llm.js';
import { AnthropicLLM } from './anthropic.js';
import { GoogleAccount, type GoogleConfig } from './google.js';
import type { Vault } from '../../vault.js';
import type { TrainingService } from '../training/service.js';
import { buildConversation, recentScreenshot, splitForDiscord, unanswered, type ChatLine } from './history.js';
import { catchUpHeader, catchUpNote, catchUpSince, HEARTBEAT_MS, LastSeen, missedMessages } from './catchUp.js';
import { discordReader, isForward, messageAttachments, messageText, openLinks } from './discordLinks.js';
import { ReminderStore } from './reminders.js';
import { TaskRunner, TaskStore } from './tasks.js';
import { updateRegistry } from './factoryDigest.js';
import { codeJobPrompt, inShadow, latestTesting, writeRunNote } from './codeJobs.js';
import { jobSettings } from './factory.js';
import { MemoryStore } from './memory.js';
import { ReadLog } from './readLog.js';
import { dirname, join } from 'node:path';
import { SavedPlaces } from './places.js';
import { tripDigests } from './placesTools.js';
import { BACKFILL_MS, IDLE_MS, Journal, splitSessions, summarize, type JournalLine } from './journal.js';
import { toLocalIso, toLocalShort } from './time.js';
import { ActivityLog, ASK_CHARS, newTrace } from './activity.js';
import { addUsage } from './usage.js';
import { usageSummary } from './report.js';
import { addInboxEvents, inboxEventsFact } from './inboxEvents.js';
import { BriefState, briefChannel, briefFacts, BRIEF_MARK, briefWeatherPlaces, isBrief, writeBrief } from './brief.js';
import { isAudio } from './voice.js';
import { TicketStore, ticketTarget } from './tickets.js';
import type { Usage } from './llm.js';
import type { ChannelToolsConfig } from './channelTools.js';
import { ollamaEmbedder, SemanticIndex } from './semantic.js';
import { isReviewDay, weeklyFacts, WEEKLY_RULES } from './weekly.js';
import { runSyncs } from './sync.js';
import { HEALTH_FOLDER, nightlyHealth } from './vaultLint.js';
import { VAULT_HEALTH_PROMPT, weeklyVaultHealth } from './vaultHealth.js';
import { overCap, updateRegistryNote } from './governance.js';
import { evalHistory } from './evals.js';
import { buildProfile, collectFromServer, MIN_MESSAGES, StyleStore } from './style.js';

export interface AssistantOptions {
  /** Channels where any message from the owner gets a reply. */
  channelIds: string[];
  /** Who the assistant talks to; with no owner set, anyone in those channels. */
  ownerId?: string;
  model: string;
  taskModel: string;
  effort: Effort;
  timeZone: string;
  remindersFile: string;
  tasksFile: string;
  memoryFile: string;
  /** Summaries of past conversations. */
  journalFile: string;
  /** The activity log's folder: what each reply did and cost. Local only. */
  activityDir: string;
  /** Local hour for the morning brief; undefined turns it off. */
  briefHour?: number;
  /** Remembers the day the last brief went out, and its channel. */
  briefFile: string;
  /** The brief's channel, by ID; otherwise #misc, found by name once and kept by ID. */
  briefChannelId?: string;
  /** Messages the owner flagged with /ticket or the Ticket menu, for the nightly review. */
  ticketsFile: string;
  profile?: OwnerProfile;
  /** The training module's log, so gym talk reads and writes the real thing. */
  training?: TrainingService;
  /** Gmail and Calendar, when an OAuth client is configured. */
  google?: GoogleConfig;
  /** The Obsidian vault, for notes and task reports. */
  vault?: Vault;
  /** Saved Google Maps lists. */
  places?: { listUrls: string[]; apiKey?: string; file: string; home?: string };
  /** Which tools each channel in the chosen category gets. */
  channelTools?: ChannelToolsConfig;
  /** Search by meaning over notes and the journal, with a local Ollama model. */
  semantic?: { host: string; model: string; file: string };
  /** The weekday whose brief is the weekly review. */
  weeklyDay?: string;
  /** The owner's own messages and the voice profile built from them; needs ownerId. */
  styleFile?: string;
}

/** How many recent channel messages make up the conversation. */
const HISTORY_LIMIT = 30;
/** Lines older than this before the newest message are left out. */
const HISTORY_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const REMINDER_POLL_MS = 15_000;
/** Saved lists change rarely; reading them a few times a day is plenty. */
const PLACES_SYNC_MS = 6 * 3600_000;
const TRIP_CHECK_MS = 3600_000;
/** How often the nightly vault upkeep (syncs, lint) checks whether today's run is due. */
const UPKEEP_CHECK_MS = 30 * 60_000;
/** Local hour the nightly upkeep runs from. */
const UPKEEP_HOUR = 3;
/** Trip digests go out from this local hour on, not overnight. */
const TRIP_DIGEST_HOUR = 8;
const JOURNAL_SWEEP_MS = 10 * 60_000;
/** How often notes and the journal are re-read for search by meaning; only what changed is embedded. */
const SEMANTIC_REFRESH_MS = 30 * 60_000;
/** Most messages one sweep reads per channel, a page of 100 at a time. */
const JOURNAL_MAX_PAGES = 5;

/**
 * A conversational assistant. Anything the owner types in one of the listed
 * channels gets a reply — no slash command — and it can search the web and
 * set reminders that post back into the channel later.
 */
export function assistantModule(opts: AssistantOptions): BotModule {
  const channels = new Set(opts.channelIds);
  const llm = new AnthropicLLM();
  const reminders = new ReminderStore(opts.remindersFile, opts.timeZone);
  const memory = new MemoryStore(opts.memoryFile);
  const journal = new Journal(opts.journalFile);
  const activity = new ActivityLog(opts.activityDir, opts.timeZone);
  activity.prune();
  const briefState = new BriefState(opts.briefFile);
  const tickets = new TicketStore(opts.ticketsFile);
  // Writing like the owner needs to know who the owner is, or other people's messages would get in.
  const style = opts.styleFile && opts.ownerId ? new StyleStore(opts.styleFile) : undefined;
  /** Set once the bot is ready with the brief on: writes and posts one now. */
  let sendBriefNow: (() => Promise<void>) | undefined;
  // Configured but never signed in, or the token file is unreadable: carry on
  // without Gmail rather than refuse to start.
  let google: GoogleAccount | undefined;
  if (opts.google) {
    try {
      google = new GoogleAccount(opts.google);
    } catch (err) {
      console.error(`[assistant] Gmail and Calendar are off: ${err instanceof Error ? err.message : String(err)}`);
    }
    // Extra Gmail accounts: one that isn't signed in is left out, not fatal.
    for (const extra of google ? (opts.google.extraMail ?? []) : []) {
      try {
        google!.extraMail.push(new GoogleAccount({ ...opts.google, ...extra }));
      } catch (err) {
        console.error(`[assistant] Gmail account "${extra.name}" is off: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  const { vault } = opts;
  // Shared by the chat and its workers: a recipe researched by one is often saved by the other.
  const reads = new ReadLog(join(dirname(opts.tasksFile), 'read-pages.json'));
  const places = opts.places ? new SavedPlaces(opts.places) : undefined;
  const semantic = opts.semantic ? new SemanticIndex(opts.semantic.file, opts.semantic.model, ollamaEmbedder(opts.semantic.host, opts.semantic.model), { vault, journal }) : undefined;
  // The job registry in Factory/README.md, once its markers are there (npm run factory -- registry --apply adds them).
  if (vault) {
    try {
      if (updateRegistry(vault).wrote) console.log('[factory] updated the job registry in Factory/README.md');
      if (updateRegistryNote(vault, activity, (job) => evalHistory(vault, job)[0])) console.log('[factory] updated Factory/Registry.md');
    } catch (err) {
      console.error('[factory] could not update the job registry:', err);
    }
  }
  /** A code job's model from its job note: fast is the chat model, capable the task model. */
  const jobModel = (job: string): ModelOptions => {
    const s = vault ? jobSettings(vault, job) : undefined;
    const effort = s?.effort && (EFFORTS as string[]).includes(s.effort) ? (s.effort as Effort) : 'low';
    return { model: s?.tier === 'capable' ? opts.taskModel : opts.model, effort };
  };
  const tasks = new TaskRunner(new TaskStore(opts.tasksFile), {
    llm,
    model: opts.taskModel,
    fastModel: opts.model,
    effort: opts.effort,
    timeZone: opts.timeZone,
    reminders,
    profile: opts.profile,
    memory,
    google,
    vault,
    reads,
    places,
    journal,
    activity,
    style,
  });
  const agent = new Agent({
    llm,
    model: opts.model,
    effort: opts.effort,
    timeZone: opts.timeZone,
    reminders,
    tasks,
    profile: opts.profile,
    memory,
    training: opts.training,
    google,
    vault,
    reads,
    places,
    journal,
    ...(opts.briefHour !== undefined ? { brief: briefState } : {}),
    semantic,
    channelTools: opts.channelTools,
    style,
  });

  // One reply at a time per channel. A second message sent while the first is
  // being answered waits, then is answered with both in view.
  const queues = new Map<string, Promise<void>>();
  const enqueue = (channelId: string, job: () => Promise<void>) => {
    const next = (queues.get(channelId) ?? Promise.resolve()).then(job, job);
    queues.set(channelId, next.catch(() => {}));
    return next;
  };
  // Messages that arrived while their channel was busy and are already
  // covered by the reply that follows: skip answering them twice.
  const answeredUpTo = new Map<string, bigint>();

  const isFromOwner = (m: Message) => !m.author.bot && (!opts.ownerId || m.author.id === opts.ownerId);

  /** Set when answering messages that arrived while the bot was down; see catchUp.ts. */
  interface CatchUp {
    /** The missed messages, oldest first; `message` is the newest. */
    missed: ChatLine[];
    lastSeen?: Date;
    startedAt: Date;
  }

  async function answer(message: Message, catchUp?: CatchUp) {
    const channel = message.channel;
    if (!channel.isSendable() || !('messages' in channel)) return;
    const seen = answeredUpTo.get(channel.id);
    if (seen !== undefined && BigInt(message.id) <= seen) return;

    const typing = setInterval(() => void channel.sendTyping().catch(() => {}), 8_000);
    void channel.sendTyping().catch(() => {});
    const started = Date.now();
    const trace = newTrace();
    const voice = messageAttachments(message).some(isAudio);
    let ask = messageText(message, opts.timeZone);
    const channelLabel = 'name' in channel && channel.name ? channel.name : 'dm';
    try {
      // A catch-up reads far enough back to see every missed message.
      const recent = await channel.messages.fetch({ limit: catchUp ? Math.min(100, Math.max(HISTORY_LIMIT, catchUp.missed.length + 10)) : HISTORY_LIMIT });
      const sorted = [...recent.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
      let lines: ChatLine[] = sorted.map((m) => ({
        id: m.id,
        // A forward's reference points at the forwarded message, not at
        // something it answers.
        replyToId: isForward(m) ? undefined : m.reference?.messageId,
        authorId: m.author.id,
        content: messageText(m, opts.timeZone),
        createdAt: m.createdAt,
        attachments: messageAttachments(m).map((a) => ({ url: a.url, contentType: a.contentType, name: a.name })),
      }));
      // Open what the messages being answered carry: their images, short
      // links, and Discord links. Older lines keep just their text.
      const reader = discordReader(message.client, opts.ownerId, opts.timeZone);
      const ids = { botId: message.client.user.id, userId: message.author.id };
      const opened = new Map<string, ChatLine>();
      const shot = recentScreenshot(lines, ids);
      for (const line of [...unanswered(lines, ids), ...(shot ? [shot] : [])]) {
        const m = recent.get(line.id!);
        if (m) opened.set(line.id!, await openLinks(m, line, reader, opts.timeZone));
      }
      lines = lines.map((l) => opened.get(l.id!) ?? l);
      if (catchUp) {
        const note = catchUpNote(catchUp.missed.length, catchUp.lastSeen, catchUp.startedAt, opts.timeZone);
        lines = lines.map((l) => (l.id === message.id ? { ...l, notes: [...(l.notes ?? []), note] } : l));
      }
      // A voice note's transcript only exists once it has been opened.
      ask = opened.get(message.id)?.content ?? ask;
      const newestId = [...recent.keys()].reduce((max, id) => (BigInt(id) > max ? BigInt(id) : max), BigInt(message.id));
      answeredUpTo.set(channel.id, newestId);

      const channelName = 'name' in channel && channel.name ? channel.name : 'dm';
      const conversation = buildConversation(lines, {
        botId: message.client.user.id,
        userId: message.author.id,
        channelName,
        timeZone: opts.timeZone,
        // A long outage can put the first missed message past the usual window.
        maxAgeMs: catchUp ? Math.max(HISTORY_MAX_AGE_MS, message.createdTimestamp - catchUp.missed[0]!.createdAt.getTime() + 3600_000) : HISTORY_MAX_AGE_MS,
      });
      if (conversation.length === 0) return;

      const categoryName = 'parent' in channel && channel.parent ? channel.parent.name : undefined;
      const text = await agent.reply(conversation, { channelId: channel.id, channelName, categoryName, discord: reader, trace });
      const [first, ...rest] = splitForDiscord(catchUp ? `${catchUpHeader(catchUp.missed.length)}\n${text}` : text);
      if (first) await message.reply({ content: first, allowedMentions: { repliedUser: false } });
      for (const part of rest) await channel.send({ content: part, allowedMentions: { parse: [] } });
      logReply(trace.outcome);
    } catch (err) {
      console.error('[assistant] reply failed:', err);
      const detail = err instanceof Error ? err.message : String(err);
      logReply('error', detail.slice(0, 300));
      await message.reply({ content: `⚠️ I couldn't answer that: ${detail.slice(0, 300)}`, allowedMentions: { repliedUser: false } }).catch(() => {});
    } finally {
      clearInterval(typing);
    }

    function logReply(outcome: string, error?: string) {
      activity.record({
        kind: 'reply',
        outcome,
        channel: channelLabel,
        messageId: message.id,
        ask: `${catchUp ? `[catch-up of ${catchUp.missed.length} missed] ` : ''}${ask}`.replace(/\s+/g, ' ').slice(0, ASK_CHARS),
        ...(voice ? { voice } : {}),
        ...(error ? { error } : {}),
        ms: Date.now() - started,
        calls: trace.calls,
        tools: trace.tools,
        usage: trace.usage,
      });
    }
  }

  /**
   * Answers, in one reply per channel, the owner's messages that arrived while
   * the bot was down. Queued like any reply, so a message sent during startup
   * waits for it and isn't answered twice.
   */
  async function catchUpChannel(client: Client<true>, channelId: string, lastSeen: Date | undefined, startedAt: Date) {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isTextBased() || !('messages' in channel)) return;
    const fetched = [...(await channel.messages.fetch({ limit: 100 })).values()];
    const lines: ChatLine[] = fetched.map((m) => ({
      id: m.id,
      replyToId: isForward(m) ? undefined : m.reference?.messageId,
      authorId: m.author.id,
      content: messageText(m, opts.timeZone),
      createdAt: m.createdAt,
      attachments: messageAttachments(m).map((a) => ({ url: a.url, contentType: a.contentType, name: a.name })),
    }));
    const userId = opts.ownerId ?? fetched.find((m) => isFromOwner(m))?.author.id;
    if (!userId) return;
    const missed = missedMessages(lines, { botId: client.user.id, userId, since: catchUpSince(lastSeen, startedAt), startedAt });
    const newest = missed.at(-1) && fetched.find((m) => m.id === missed.at(-1)!.id);
    if (!newest) return;
    const label = 'name' in channel && channel.name ? `#${channel.name}` : 'a DM';
    console.log(`[catch-up] ${missed.length} message(s) in ${label} arrived while the bot was down`);
    await enqueue(channelId, () => answer(newest, { missed, lastSeen, startedAt }));
  }

  async function fireDue(client: Client<true>) {
    for (const r of reminders.takeDue()) {
      const late = Date.now() - new Date(r.due).getTime() > 5 * 60_000;
      const who = opts.ownerId ? `<@${opts.ownerId}> ` : '';
      const note = late ? `\n-# Was due ${toLocalShort(new Date(r.due), opts.timeZone)} — the bot was offline.` : '';
      const repeat = r.repeat !== 'none' ? `\n-# Repeats ${r.repeat}. Ask me to cancel ${r.id} to stop it.` : '';
      try {
        const channel = await client.channels.fetch(r.channelId);
        if (!channel?.isSendable()) throw new Error(`channel ${r.channelId} is not one I can post in`);
        await channel.send({
          content: `⏰ ${who}${r.text}${note}${repeat}`,
          allowedMentions: { users: opts.ownerId ? [opts.ownerId] : [] },
        });
      } catch (err) {
        console.error(`[assistant] reminder ${r.id} could not be delivered:`, err);
      }
    }
  }

  /**
   * Summarises each listed channel's finished conversations into the journal:
   * everything after the channel's cursor (or the last few days, the first
   * time), split at long gaps, leaving the one still going.
   */
  async function sweepJournal(client: Client<true>) {
    let used: Usage | undefined;
    let summarised = 0;
    const onUsage = (u: Usage) => {
      used = used ? addUsage(used, u) : u;
      summarised += 1;
    };
    try {
      for (const channelId of opts.channelIds) await sweepChannel(client, channelId, onUsage);
    } finally {
      if (summarised) activity.record({ kind: 'journal', outcome: 'ok', calls: summarised, usage: used });
    }
  }

  async function sweepChannel(client: Client<true>, channelId: string, onUsage: (u: Usage) => void) {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel || !('messages' in channel) || !channel.isTextBased()) return;
    const cursor = journal.cursor(channelId);
    const fetched: Message[] = [];
    let truncated = false;
    if (cursor) {
      let after = cursor;
      for (let page = 0; page < JOURNAL_MAX_PAGES; page++) {
        const batch = [...(await channel.messages.fetch({ after, limit: 100 })).values()];
        if (batch.length === 0) break;
        fetched.push(...batch);
        after = batch.reduce((max, m) => (BigInt(m.id) > BigInt(max) ? m.id : max), after);
        if (batch.length < 100) break;
        truncated = page === JOURNAL_MAX_PAGES - 1;
      }
    } else {
      let before: string | undefined;
      for (let page = 0; page < JOURNAL_MAX_PAGES; page++) {
        const batch = [...(await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) })).values()];
        if (batch.length === 0) break;
        fetched.push(...batch);
        before = batch.reduce((min, m) => (BigInt(m.id) < BigInt(min) ? m.id : min), batch[0]!.id);
        if (batch.length < 100 || Math.min(...batch.map((m) => m.createdTimestamp)) < Date.now() - BACKFILL_MS) break;
      }
    }
    const botId = client.user.id;
    const lines: JournalLine[] = fetched
      .filter((m) => m.createdTimestamp >= Date.now() - BACKFILL_MS || cursor)
      .filter((m) => m.author.id === botId || isFromOwner(m))
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
      .map((m) => ({ id: m.id, fromOwner: m.author.id !== botId, at: m.createdAt, text: messageText(m, opts.timeZone), ...(m.author.id === botId && isBrief(m.content) ? { brief: true } : {}) }))
      .filter((l) => l.text.trim());
    const sessions = splitSessions(lines);
    // The newest conversation may still be going, or run past what was read.
    if (sessions.length && (truncated || Date.now() - sessions.at(-1)!.at(-1)!.at.getTime() < IDLE_MS)) sessions.pop();
    const channelName = 'name' in channel && channel.name ? channel.name : 'dm';
    for (const session of sessions) {
      const last = session.at(-1)!;
      const today = new Date().toISOString().slice(0, 10);
      const open = journal.entries().filter((e) => e.ongoing && e.ongoing.until >= today);
      const { entry, settled } = session.some((l) => l.fromOwner)
        ? await summarize(llm, { model: opts.model, effort: 'low' }, channelName, session, opts.timeZone, onUsage, open)
        : { entry: undefined, settled: [] };
      for (const s of settled) journal.settle(s.id, s.note, last.at, channelName, opts.timeZone);
      journal.done(
        channelId,
        last.id,
        entry && { channelId, channelName, from: session[0]!.at.toISOString(), to: last.at.toISOString(), ...entry },
      );
    }
  }

  const tasksCommand = {
    data: new SlashCommandBuilder().setName('tasks').setDescription('List the assistant\'s background tasks'),
    async run(i: import('discord.js').ChatInputCommandInteraction) {
      const all = tasks.list();
      const body = all.length
        ? all
            .map((t) => {
              const next = t.status === 'waiting' && t.wakeAt ? `, next ${toLocalShort(new Date(t.wakeAt), opts.timeZone)}` : '';
              return `\`${t.id}\` **${t.title}** · ${t.status}${next} · ends ${toLocalShort(new Date(t.deadline), opts.timeZone)} <#${t.channelId}>`;
            })
            .join('\n')
        : 'No tasks.';
      await i.reply({ content: splitForDiscord(body)[0]!, flags: MessageFlags.Ephemeral });
    },
  };

  const memoriesCommand = {
    data: new SlashCommandBuilder().setName('memories').setDescription('List what the assistant remembers about you'),
    async run(i: import('discord.js').ChatInputCommandInteraction) {
      const all = memory.list();
      const body = all.length ? all.map((m) => `\`${m.id}\` ${m.text}`).join('\n') : 'Nothing remembered yet.';
      const [first, ...rest] = splitForDiscord(body);
      await i.reply({ content: first!, flags: MessageFlags.Ephemeral });
      for (const part of rest) await i.followUp({ content: part, flags: MessageFlags.Ephemeral });
    },
  };

  const remindersCommand = {
    data: new SlashCommandBuilder().setName('reminders').setDescription('List pending reminders from the assistant'),
    async run(i: import('discord.js').ChatInputCommandInteraction) {
      const all = reminders.list();
      const body = all.length
        ? all.map((r) => `\`${r.id}\` ${toLocalShort(new Date(r.due), opts.timeZone)}${r.repeat !== 'none' ? ` (${r.repeat})` : ''} <#${r.channelId}> — ${r.text}`).join('\n')
        : 'No pending reminders.';
      await i.reply({ content: splitForDiscord(body)[0]!, flags: MessageFlags.Ephemeral });
    },
  };

  const usageCommand = {
    data: new SlashCommandBuilder()
      .setName('usage')
      .setDescription("What the assistant's API calls have cost")
      .addIntegerOption((o) => o.setName('days').setDescription('How many days back (default 7)').setMinValue(1).setMaxValue(120)),
    async run(i: import('discord.js').ChatInputCommandInteraction) {
      const days = i.options.getInteger('days') ?? 7;
      const body = usageSummary(activity.read(new Date(Date.now() - days * 86_400_000)), opts.timeZone, days);
      const [first, ...rest] = splitForDiscord(body);
      await i.reply({ content: first!, flags: MessageFlags.Ephemeral });
      for (const part of rest) await i.followUp({ content: part, flags: MessageFlags.Ephemeral });
    },
  };

  // Google Maps lists can't be written to, so spots saved by chat live only in
  // Squire's copy until they're saved in Maps too. This is that to-do list;
  // each one drops off on the next sync after it shows up in the Maps list.
  const mapsTodoCommand = {
    data: new SlashCommandBuilder().setName('maps-todo').setDescription("Spots saved in Squire that aren't in your Google Maps lists yet"),
    async run(i: import('discord.js').ChatInputCommandInteraction) {
      const pending = places?.places().filter((p) => p.source === 'chat') ?? [];
      const byList = new Map<string, typeof pending>();
      for (const p of pending) byList.set(p.list, [...(byList.get(p.list) ?? []), p]);
      const body = pending.length
        ? `Tap a link and Save it to the list named. Each drops off here once Squire's next sync sees it in Maps.\n\n${[...byList]
            .map(([list, ps]) => `**${list}**\n${ps.map((p) => `- [${p.name.replace(/[[\]]/g, '')}](<${p.mapsUrl}>)${p.note ? ` · ${p.note}` : ''}`).join('\n')}`)
            .join('\n\n')}`
        : 'Nothing to add: every saved spot is in your Google Maps lists.';
      const [first, ...rest] = splitForDiscord(body);
      await i.reply({ content: first!, flags: MessageFlags.Ephemeral });
      for (const part of rest) await i.followUp({ content: part, flags: MessageFlags.Ephemeral });
    },
  };

  /** Files a ticket about one message, with the message it answered, and says so privately. */
  async function fileTicket(
    i: ChatInputCommandInteraction | ModalSubmitInteraction,
    target: { channelId: string; messageId: string },
    note: string,
  ) {
    const channel = await i.client.channels.fetch(target.channelId).catch(() => null);
    if (!channel || !channel.isTextBased() || !('messages' in channel)) throw new Error("I can't read that channel.");
    const m = await channel.messages.fetch(target.messageId).catch(() => null);
    if (!m) throw new Error("I couldn't find that message. Use its link (right-click → Copy Message Link).");
    const ref = m.reference?.messageId && !isForward(m) ? await channel.messages.fetch(m.reference.messageId).catch(() => null) : null;
    const t = tickets.add({
      note,
      messageId: m.id,
      channelId: m.channelId,
      channelName: 'name' in channel && channel.name ? channel.name : 'dm',
      link: m.url,
      author: m.author.id === i.client.user.id ? 'Squire' : m.author.id === opts.ownerId ? 'Owner' : m.author.username,
      postedAt: m.createdAt.toISOString(),
      text: messageText(m, opts.timeZone) || '(no text)',
      ...(ref ? { replyTo: { messageId: ref.id, text: messageText(ref, opts.timeZone) } } : {}),
    });
    const open = tickets.list('open').length;
    await i.reply({
      content: `🎫 Ticket \`${t.id}\` filed on ${m.url}. Tonight's review will pick it up${open > 1 ? ` (${open} open)` : ''}.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  const ticketCommand = {
    data: new SlashCommandBuilder()
      .setName('ticket')
      .setDescription("Flag something wrong with one of Squire's messages, for the nightly review")
      .addStringOption((o) => o.setName('note').setDescription("What's wrong, or what it should have done").setRequired(true).setMaxLength(1500))
      .addStringOption((o) => o.setName('message').setDescription("The message's link or ID; leave empty for Squire's latest message here")),
    async run(i: ChatInputCommandInteraction) {
      const note = i.options.getString('note', true);
      const given = i.options.getString('message')?.trim();
      if (given) {
        const target = ticketTarget(given, i.channelId);
        if (!target) throw new Error("That isn't a message link or ID. Right-click the message → Copy Message Link.");
        return fileTicket(i, target, note);
      }
      const channel = i.channel;
      if (!channel || !('messages' in channel)) throw new Error("I can't read this channel; pass the message's link.");
      const recent = await channel.messages.fetch({ limit: 50 });
      const latest = [...recent.values()].filter((m) => m.author.id === i.client.user.id).sort((a, b) => b.createdTimestamp - a.createdTimestamp)[0];
      if (!latest) throw new Error("I haven't posted here lately; pass the message's link.");
      return fileTicket(i, { channelId: channel.id, messageId: latest.id }, note);
    },
  };

  const briefCommand = {
    data: new SlashCommandBuilder().setName('brief').setDescription('Send the morning brief now'),
    async run(i: ChatInputCommandInteraction) {
      if (!sendBriefNow) throw new Error(opts.briefHour === undefined ? 'The morning brief is off (MORNING_BRIEF_HOUR is unset).' : "The bot isn't ready yet; try again in a minute.");
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      await sendBriefNow();
      await i.editReply('☀️ Sent.');
    },
  };

  /**
   * Reads the owner's messages across the server, all the way back the
   * first time and what's new after that, then builds the voice profile.
   * Runs once when there's no profile yet, and on /voice refresh; never on
   * a timer. One run at a time.
   */
  let styling: Promise<string> | undefined;
  const refreshStyle = (client: Client<true>): Promise<string> => {
    if (!style || !opts.ownerId) return Promise.resolve('Writing like you is off.');
    if (styling) return styling;
    const ownerId = opts.ownerId;
    const run = async () => {
      const started = Date.now();
      let read = { scanned: 0, added: 0, channels: 0, more: true };
      // Several passes on the first read, until every channel is read to its start.
      for (let pass = 0; pass < 30 && read.more; pass++) {
        const r = await collectFromServer(client, style, ownerId, channels, (l) => console.error(l));
        read = { scanned: read.scanned + r.scanned, added: read.added + r.added, channels: r.channels, more: r.more && r.scanned > 0 };
      }
      let line = `Read ${read.scanned} messages in ${read.channels} channels and threads; ${read.added} new of yours, ${style.size} in all.`;
      if (style.size >= MIN_MESSAGES) {
        try {
          const built = await buildProfile(llm, { model: opts.taskModel, effort: 'low' }, style);
          activity.record({ kind: 'style', outcome: built.profile ? 'ok' : 'error', ms: Date.now() - started, calls: 1, usage: built.usage, ...(built.reason ? { error: built.reason } : {}) });
          line += built.profile ? ` Voice profile rebuilt from ${built.profile.corpusSize} messages, with ${built.profile.examples.length} examples.` : ` Profile not rebuilt: ${built.reason}.`;
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          activity.record({ kind: 'style', outcome: 'error', ms: Date.now() - started, error: detail.slice(0, 300) });
          line += ` Profile not rebuilt: ${detail.slice(0, 200)}`;
        }
      } else line += ` Need at least ${MIN_MESSAGES} to build a profile.`;
      console.log(`[style] ${line}`);
      return line;
    };
    styling = run().finally(() => (styling = undefined));
    return styling;
  };

  const styleCommand = {
    data: new SlashCommandBuilder()
      .setName('voice')
      .setDescription('How Squire writes like you, from your own messages')
      .addSubcommand((s) => s.setName('show').setDescription('Show the voice profile and a few of the examples it uses'))
      .addSubcommand((s) => s.setName('refresh').setDescription('Read your newest messages and rebuild the profile now'))
      .addSubcommand((s) => s.setName('on').setDescription('Write in your voice'))
      .addSubcommand((s) => s.setName('off').setDescription('Go back to the default voice; your messages and profile are kept')),
    async run(i: ChatInputCommandInteraction) {
      if (!style) throw new Error(opts.ownerId ? 'Writing like you is off (ASSISTANT_VOICE=off).' : 'Set DISCORD_ADMIN_ID first, so only your own messages are read.');
      const sub = i.options.getSubcommand();
      if (sub === 'on' || sub === 'off') {
        style.setEnabled(sub === 'on');
        const note = sub === 'on' && !style.profile ? " There's no profile yet; run `/voice refresh`." : '';
        await i.reply({ content: `${sub === 'on' ? "Writing in your voice." : 'Back to the default voice.'}${note}`, flags: MessageFlags.Ephemeral });
        return;
      }
      if (sub === 'refresh') {
        await i.deferReply({ flags: MessageFlags.Ephemeral });
        // The very first read can outlast the 15 minutes Discord allows for an answer; the log has it then.
        const line = await refreshStyle(i.client);
        await i.editReply(line).catch(() => console.log(`[style] /voice refresh finished after Discord stopped waiting: ${line}`));
        return;
      }
      const p = style.profile;
      const body = p
        ? `**Voice** ${style.enabled ? 'on' : 'off'} · built ${toLocalShort(new Date(p.builtAt), opts.timeZone)} from ${p.corpusSize} of your messages (${style.size} collected now)\n\n${p.guide}\n\n**Counts:** ${p.stats}\n\n**Some examples:**\n${p.examples.slice(0, 8).map((e) => `> ${e.replace(/\n/g, ' / ')}`).join('\n')}`
        : `No profile yet; ${style.size} of your messages collected. Run \`/voice refresh\`.`;
      const [first, ...rest] = splitForDiscord(body);
      await i.reply({ content: first!, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
      for (const part of rest) await i.followUp({ content: part, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    },
  };

  const ticketsCommand = {
    data: new SlashCommandBuilder().setName('tickets').setDescription('List open tickets the nightly review has yet to handle'),
    async run(i: ChatInputCommandInteraction) {
      const open = tickets.list('open');
      const body = open.length
        ? open.map((t) => `\`${t.id}\` ${toLocalShort(new Date(t.at), opts.timeZone)} ${t.link} · ${t.note.replace(/\s+/g, ' ').slice(0, 200)}`).join('\n')
        : 'No open tickets.';
      const [first, ...rest] = splitForDiscord(body);
      await i.reply({ content: first!, flags: MessageFlags.Ephemeral });
      for (const part of rest) await i.followUp({ content: part, flags: MessageFlags.Ephemeral });
    },
  };

  // Right-click (or long-press) a message → Apps → Ticket: asks what's wrong, then files it.
  const ticketMenu = {
    data: new ContextMenuCommandBuilder().setName('Ticket').setType(ApplicationCommandType.Message),
    async run(i: MessageContextMenuCommandInteraction) {
      const modal = new ModalBuilder()
        .setCustomId(`ticket:${i.targetMessage.channelId}:${i.targetId}`)
        .setTitle('Ticket this message')
        .addComponents(
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder()
              .setCustomId('note')
              .setLabel("What's wrong, or what should it have done?")
              .setStyle(TextInputStyle.Paragraph)
              .setRequired(true)
              .setMaxLength(1500),
          ),
        );
      await i.showModal(modal);
    },
  };
  const ticketModal = {
    prefix: 'ticket',
    async run(i: ModalSubmitInteraction) {
      const [, channelId, messageId] = i.customId.split(':');
      if (!channelId || !messageId) throw new Error('That ticket form is missing its message.');
      await fileTicket(i, { channelId, messageId }, i.fields.getTextInputValue('note'));
    },
  };

  return {
    name: 'assistant',
    commands: [remindersCommand, tasksCommand, memoriesCommand, usageCommand, ticketCommand, ticketsCommand, briefCommand, styleCommand, ...(places ? [mapsTodoCommand] : [])],
    messageMenus: [ticketMenu],
    modals: [ticketModal],
    intents: [GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    describe: () => [
      `Assistant             ${opts.model} (effort ${opts.effort}) in ${opts.channelIds.length} channel(s)`,
      `Background tasks use  ${opts.taskModel}, or ${opts.model} for simple ones`,
      `Reminders             ${reminders.list().length} pending in ${reminders.file} (${opts.timeZone})`,
      `Background tasks      ${tasks.active().length} unfinished in ${opts.tasksFile}`,
      `Memory                ${memory.list().length} memories in ${memory.file}`,
      `Journal               ${journal.entries().length} past conversations in ${journal.file}`,
      `Activity log          ${activity.folder} (local only)`,
      `Tickets               ${tickets.list('open').length} open in ${tickets.file}`,
      `Morning brief         ${opts.briefHour === undefined ? 'off' : `${opts.briefHour}:00 in ${opts.briefChannelId ?? briefState.channelId ?? '#misc (found by name once, then kept by ID)'}`}`,
      `Gmail and Calendar    ${google ? `on${google.extraMail.length ? `; Gmail accounts: ${google.mailboxes().map((m) => m.name).join(', ')}` : ''}${(opts.google?.extraMail?.length ?? 0) > google.extraMail.length ? ' (some extra accounts not signed in; see the log)' : ''}` : opts.google ? 'off (sign-in failed; run npm run google:auth)' : 'off (set GOOGLE_CLIENT_ID to enable)'}`,
      `Notes                 ${vault ? `${vault.root}` : 'off'}`,
      `Search by meaning     ${semantic ? `${opts.semantic!.model} via ${opts.semantic!.host}; ${semantic.size} items in ${semantic.file}` : 'off'}`,
      `Channel tools         ${opts.channelTools?.category ? `by channel name in the "${opts.channelTools.category}" category` : 'every tool in every channel'}`,
      `Voice                 ${style ? `${style.enabled ? 'on' : 'off'}; ${style.size} of your messages, ${style.profile ? `profile built ${toLocalShort(new Date(style.profile.builtAt), opts.timeZone)}` : 'no profile yet'}; ${style.file}` : opts.ownerId ? 'off (ASSISTANT_VOICE=off)' : 'off (needs DISCORD_ADMIN_ID)'}`,
      `Weekly review         ${opts.weeklyDay && opts.briefHour !== undefined ? `${opts.weeklyDay}, in place of the brief` : 'off'}`,
      `Saved places          ${places ? `${places.places().length} in ${places.lists().length} list(s), ${opts.places?.apiKey ? 'with hours' : 'no GOOGLE_MAPS_API_KEY, so no hours'}; ${places.store.file}` : 'off (set MAPS_LIST_URLS to enable)'}`,
    ],
    onReady(client) {
      // Read the last heartbeat before the first new one overwrites it.
      const startedAt = new Date();
      const lastSeen = new LastSeen(join(dirname(opts.briefFile), 'last-seen.json'));
      const lastUp = lastSeen.read();
      lastSeen.touch(startedAt);
      setInterval(() => lastSeen.touch(), HEARTBEAT_MS);
      for (const channelId of opts.channelIds) {
        void catchUpChannel(client, channelId, lastUp, startedAt).catch((err) => console.error(`[catch-up] ${channelId} failed:`, err));
      }

      const post = async (channelId: string, content: string, ping: boolean) => {
        const channel = await client.channels.fetch(channelId);
        if (!channel?.isSendable()) throw new Error(`channel ${channelId} is not one I can post in`);
        const parts = splitForDiscord(ping && opts.ownerId ? `<@${opts.ownerId}> ${content}` : content);
        for (const [n, part] of parts.entries()) {
          await channel.send({ content: part, allowedMentions: { users: ping && n === 0 && opts.ownerId ? [opts.ownerId] : [] } });
        }
      };
      // A task note written by hand names its channel ("#recipes"): the assistant's own channels first.
      const findChannel = (name: string) => {
        const named = (c: unknown) => !!c && typeof c === 'object' && 'name' in c && (c as { name?: string }).name === name;
        return opts.channelIds.find((id) => named(client.channels.cache.get(id))) ?? client.channels.cache.find((c) => named(c) && c.isSendable())?.id;
      };
      tasks.setPoster(post, findChannel);
      const tick = () => {
        void fireDue(client);
        tasks.tick();
      };
      tick();
      setInterval(tick, REMINDER_POLL_MS);

      // One sweep at a time; a slow one (the first run's backfill) isn't stacked on.
      let sweeping = false;
      const sweep = () => {
        if (sweeping) return;
        sweeping = true;
        void sweepJournal(client)
          .catch((err) => console.error('[journal] sweep failed:', err))
          .finally(() => (sweeping = false));
      };
      setTimeout(sweep, 30_000);
      setInterval(sweep, JOURNAL_SWEEP_MS);

      if (opts.briefHour !== undefined) {
        const hour = opts.briefHour;
        let sending = false;
        let failures = 0;
        // Writes and posts the brief; throws when it fails. Also what /brief runs.
        const sendBrief = async () => {
          const started = Date.now();
          try {
            // Booked events found in the inbox go on the calendar first, so the brief can say so.
            // Its prompt and shadow setting come from the inbox-calendar job's notes in Factory/.
            const inboxPrompt = codeJobPrompt(vault, 'inbox-calendar');
            // Over its daily cap, the inbox step waits for tomorrow; the brief still goes out.
            const inboxCapped = overCap(vault, activity, 'inbox-calendar', opts.timeZone);
            if (inboxCapped) console.log(`[brief] skipping the inbox step: ${inboxCapped}`);
            const inbox = google && !inboxCapped
              ? await addInboxEvents(llm, jobModel('inbox-calendar'), google, opts.timeZone, briefState, new Date(), { system: inboxPrompt?.text, shadow: inShadow(vault, 'inbox-calendar') })
              : undefined;
            if (vault && inbox?.shadow && (inbox.shadow.wouldAdd.length || inbox.shadow.wouldRemove.length)) {
              writeRunNote(vault, opts.timeZone, {
                job: 'inbox-calendar',
                title: 'Inbox calendar (shadow)',
                goal: 'Add booked events from the last few days of email to the calendar.',
                report: `Shadow mode: nothing was changed on the calendar.\n\n${[...inbox.shadow.wouldAdd.map((a) => `- Would add: ${a}`), ...inbox.shadow.wouldRemove.map((a) => `- Would take off: ${a}`)].join('\n')}`,
                prompt: inboxPrompt?.name,
                shadow: true,
                channel: 'misc',
              });
            }
            const added = inboxEventsFact(inbox?.added ?? [], inbox?.removed ?? [], inbox?.stillOnCalendar ?? [], inbox?.shadow);
            const daily = `${await briefFacts({ timeZone: opts.timeZone, reminders, journal, google, places, profile: opts.profile, memory, state: briefState })}${added ? `\n\n${added}` : ''}`;
            // On the review's day, the brief becomes the weekly review: today's sections plus the week.
            const weekly = isReviewDay(new Date(), opts.timeZone, opts.weeklyDay);
            const facts = weekly ? `${daily}\n\n${await weeklyFacts({ timeZone: opts.timeZone, reminders, google, training: opts.training, activity, vault })}` : daily;
            // The wording prompt comes from the brief job's notes; the facts above stay computed in code.
            const briefPrompt = codeJobPrompt(vault, 'brief');
            const rules = `${weekly ? WEEKLY_RULES : ''}${style?.prompt() ?? ''}`;
            const { text, usage: briefUsage, missed } = await writeBrief(llm, jobModel('brief'), facts, opts.profile, briefWeatherPlaces(new Date(), opts.timeZone), rules, { system: briefPrompt?.text });
            if (!text) throw new Error('the model wrote nothing');
            // Shadow: the newest testing prompt words the same facts, kept beside the real one for comparison.
            const trial = vault && inShadow(vault, 'brief') ? latestTesting(vault, 'brief') : undefined;
            if (vault && trial) {
              try {
                const alt = await writeBrief(llm, jobModel('brief'), facts, opts.profile, [], rules, { system: trial.text });
                writeRunNote(vault, opts.timeZone, {
                  job: 'brief',
                  title: `Brief (shadow, ${trial.name})`,
                  goal: `Word today's brief with the testing prompt ${trial.name}, beside the one sent.`,
                  report: `**Sent (${briefPrompt?.name ?? 'built-in'}):**\n\n${text}\n\n**Testing (${trial.name}), not sent:**\n\n${alt.text}`,
                  prompt: `[[${trial.path!.replace(/\.md$/, '')}]]`,
                  shadow: true,
                  channel: 'misc',
                });
              } catch (err) {
                console.error('[brief] the shadow brief failed:', err);
              }
            }
            const channels = await Promise.all(
              opts.channelIds.map(async (id) => {
                const c = await client.channels.fetch(id).catch(() => null);
                return { id, name: c && 'name' in c ? (c.name ?? undefined) : undefined };
              }),
            );
            await post(briefChannel(briefState, opts.briefChannelId, channels) ?? opts.channelIds[0]!, `${BRIEF_MARK} ${text}`, false);
            briefState.sent(new Date(), opts.timeZone);
            // A place whose weather wasn't found shows under the review's problems.
            // Each job's spend is its own event, for its daily cap and the registry's 7-day cost.
            const inboxTools = [...(inbox?.added ?? []).map((a) => `calendar event added from inbox (${a.replaceAll(': ', ' - ')})`), ...(inbox?.removed ?? []).map((a) => `calendar event removed, cancelled by email (${a.replaceAll(': ', ' - ')})`), ...(inbox?.errors ?? [])];
            if (inbox) activity.record({ kind: 'job', job: 'inbox-calendar', outcome: inbox.errors?.length ? 'error' : 'ok', calls: inbox.usage ? 1 : 0, usage: inbox.usage, tools: inboxTools });
            const tools = [...missed.map((p) => `weather: no forecast found for ${p}`), ...inboxTools];
            activity.record({ kind: 'brief', job: 'brief', outcome: 'ok', ms: Date.now() - started, calls: 1, usage: briefUsage, tools });
          } catch (err) {
            console.error('[brief] failed:', err);
            activity.record({ kind: 'brief', outcome: 'error', error: (err instanceof Error ? err.message : String(err)).slice(0, 300) });
            throw err;
          }
        };
        sendBriefNow = async () => {
          if (sending) throw new Error("A brief is already being written; it'll post in a moment.");
          sending = true;
          try {
            await sendBrief();
          } finally {
            sending = false;
          }
        };
        const checkBrief = async () => {
          if (sending || !briefState.due(new Date(), opts.timeZone, hour)) return;
          sending = true;
          try {
            await sendBrief();
            failures = 0;
          } catch {
            // Not marked sent, so the next check tries again, up to three times a day.
            if (++failures >= 3) {
              failures = 0;
              briefState.sent(new Date(), opts.timeZone);
            }
          } finally {
            sending = false;
          }
        };
        const briefTick = () => void checkBrief();
        setTimeout(briefTick, 90_000);
        setInterval(briefTick, 10 * 60_000);
      }

      if (style) {
        // Built once, a few minutes after the first start; after that only /voice refresh reads or rebuilds.
        if (!style.profile) setTimeout(() => void refreshStyle(client).catch((err) => console.error('[style] first build failed:', err)), 5 * 60_000);
      }

      if (semantic) {
        let warned = false;
        const refresh = () =>
          void semantic
            .refresh()
            .then((n) => {
              if (n) console.log(`[semantic] embedded ${n} new or changed item(s); ${semantic.size} in the index`);
              warned = false;
            })
            .catch((err) => {
              // Ollama down or the model not pulled: say so once, not every half hour.
              if (!warned) console.error(`[semantic] index refresh failed: ${err instanceof Error ? err.message : String(err)}`);
              warned = true;
            });
        setTimeout(refresh, 2 * 60_000);
        setInterval(refresh, SEMANTIC_REFRESH_MS);
      }

      if (places) {
        const sync = () => void places.sync().catch((err) => console.error('[places] sync failed:', err));
        sync();
        setInterval(sync, PLACES_SYNC_MS);
        if (google) {
          // Digests go to the first assistant channel.
          const checkTrips = async () => {
            if (Number(toLocalIso(new Date(), opts.timeZone).slice(11, 13)) < TRIP_DIGEST_HOUR) return;
            for (const digest of await tripDigests(places, google, opts.timeZone)) await post(opts.channelIds[0]!, digest, true);
          };
          const tripTick = () => void checkTrips().catch((err) => console.error('[places] trip check failed:', err));
          setTimeout(tripTick, 60_000);
          setInterval(tripTick, TRIP_CHECK_MS);
        }
      }
      if (vault) {
        // Nightly vault upkeep: read-only syncs into Squire/Sync, then the lint into Squire/Health. No model calls.
        let upkeepRunning = false;
        const upkeep = async () => {
          const now = new Date();
          const local = toLocalIso(now, opts.timeZone);
          if (upkeepRunning || Number(local.slice(11, 13)) < UPKEEP_HOUR) return;
          if (vault.read(`${HEALTH_FOLDER}/${local.slice(0, 10)}.md`) !== undefined) return;
          upkeepRunning = true;
          try {
            if (google || places) {
              const status = await runSyncs(vault, { google, places: places?.places() }, opts.timeZone, now);
              console.log(`[sync] ${status.length} source(s) synced into Squire/Sync`);
            }
            console.log(`[lint] wrote ${nightlyHealth(vault, opts.timeZone, now)}`);
            updateRegistryNote(vault, activity, (job) => evalHistory(vault, job)[0], now);
            // On the weekly review's day, the vault-health factory proposes tidy-ups as a checklist. It changes nothing.
            if (isReviewDay(now, opts.timeZone, opts.weeklyDay) && vault.read(`${HEALTH_FOLDER}/${local.slice(0, 10)} proposals.md`) === undefined) {
              const started = Date.now();
              const prompt = codeJobPrompt(vault, 'vault-health') ?? { text: VAULT_HEALTH_PROMPT, name: 'built-in' };
              const capped = overCap(vault, activity, 'vault-health', opts.timeZone, now);
              try {
                if (capped) throw new Error(capped);
                const run = await weeklyVaultHealth(vault, llm, jobModel('vault-health'), prompt, opts.timeZone, now);
                activity.record({ kind: 'job', job: 'vault-health', outcome: 'ok', ms: Date.now() - started, calls: run.usage ? 1 : 0, usage: run.usage, title: `${run.proposals.length} proposal(s)` });
              } catch (err) {
                activity.record({ kind: 'job', job: 'vault-health', outcome: 'error', error: (err instanceof Error ? err.message : String(err)).slice(0, 300) });
              }
            }
          } finally {
            upkeepRunning = false;
          }
        };
        const upkeepTick = () => void upkeep().catch((err) => console.error('[upkeep] failed:', err));
        setTimeout(upkeepTick, 3 * 60_000);
        setInterval(upkeepTick, UPKEEP_CHECK_MS);
      }
    },
    async onMessage(message) {
      if (!channels.has(message.channelId) || !isFromOwner(message)) return;
      if (!message.content.trim() && message.attachments.size === 0 && message.messageSnapshots.size === 0) return;
      await enqueue(message.channelId, () => answer(message));
    },
  };
}
