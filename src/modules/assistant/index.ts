import { GatewayIntentBits, MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { Client, Message } from 'discord.js';
import type { BotModule } from '../types.js';
import { Agent, type Effort } from './agent.js';
import type { OwnerProfile } from './llm.js';
import { AnthropicLLM } from './anthropic.js';
import { GoogleAccount, type GoogleConfig } from './google.js';
import type { Vault } from '../../vault.js';
import type { TrainingService } from '../training/service.js';
import { buildConversation, recentScreenshot, splitForDiscord, unanswered, type ChatLine } from './history.js';
import { discordReader, isForward, messageAttachments, messageText, openLinks } from './discordLinks.js';
import { ReminderStore } from './reminders.js';
import { TaskRunner, TaskStore } from './tasks.js';
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
import { BriefState, briefChannel, briefFacts, writeBrief } from './brief.js';
import { isAudio } from './voice.js';
import type { Usage } from './llm.js';

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
  profile?: OwnerProfile;
  /** The training module's log, so gym talk reads and writes the real thing. */
  training?: TrainingService;
  /** Gmail and Calendar, when an OAuth client is configured. */
  google?: GoogleConfig;
  /** The Obsidian vault, for notes and task reports. */
  vault?: Vault;
  /** Saved Google Maps lists. */
  places?: { listUrls: string[]; apiKey?: string; file: string; home?: string };
}

/** How many recent channel messages make up the conversation. */
const HISTORY_LIMIT = 30;
/** Lines older than this before the newest message are left out. */
const HISTORY_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const REMINDER_POLL_MS = 15_000;
/** Saved lists change rarely; reading them a few times a day is plenty. */
const PLACES_SYNC_MS = 6 * 3600_000;
const TRIP_CHECK_MS = 3600_000;
/** Trip digests go out from this local hour on, not overnight. */
const TRIP_DIGEST_HOUR = 8;
const JOURNAL_SWEEP_MS = 10 * 60_000;
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

  async function answer(message: Message) {
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
      const recent = await channel.messages.fetch({ limit: HISTORY_LIMIT });
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
        maxAgeMs: HISTORY_MAX_AGE_MS,
      });
      if (conversation.length === 0) return;

      const text = await agent.reply(conversation, { channelId: channel.id, channelName, discord: reader, trace });
      const [first, ...rest] = splitForDiscord(text);
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
        ask: ask.replace(/\s+/g, ' ').slice(0, ASK_CHARS),
        ...(voice ? { voice } : {}),
        ...(error ? { error } : {}),
        ms: Date.now() - started,
        calls: trace.calls,
        tools: trace.tools,
        usage: trace.usage,
      });
    }
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
      .map((m) => ({ id: m.id, fromOwner: m.author.id !== botId, at: m.createdAt, text: messageText(m, opts.timeZone) }))
      .filter((l) => l.text.trim());
    const sessions = splitSessions(lines);
    // The newest conversation may still be going, or run past what was read.
    if (sessions.length && (truncated || Date.now() - sessions.at(-1)!.at(-1)!.at.getTime() < IDLE_MS)) sessions.pop();
    const channelName = 'name' in channel && channel.name ? channel.name : 'dm';
    for (const session of sessions) {
      const last = session.at(-1)!;
      const entry = session.some((l) => l.fromOwner)
        ? await summarize(llm, { model: opts.model, effort: 'low' }, channelName, session, opts.timeZone, onUsage)
        : undefined;
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

  return {
    name: 'assistant',
    commands: [remindersCommand, tasksCommand, memoriesCommand, usageCommand, ...(places ? [mapsTodoCommand] : [])],
    intents: [GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    describe: () => [
      `Assistant             ${opts.model} (effort ${opts.effort}) in ${opts.channelIds.length} channel(s)`,
      `Background tasks use  ${opts.taskModel}, or ${opts.model} for simple ones`,
      `Reminders             ${reminders.list().length} pending in ${reminders.file} (${opts.timeZone})`,
      `Background tasks      ${tasks.active().length} unfinished in ${opts.tasksFile}`,
      `Memory                ${memory.list().length} memories in ${memory.file}`,
      `Journal               ${journal.entries().length} past conversations in ${journal.file}`,
      `Activity log          ${activity.folder} (local only)`,
      `Morning brief         ${opts.briefHour === undefined ? 'off' : `${opts.briefHour}:00 in ${opts.briefChannelId ?? briefState.channelId ?? '#misc (found by name once, then kept by ID)'}`}`,
      `Gmail and Calendar    ${google ? `on${google.extraMail.length ? `; Gmail accounts: ${google.mailboxes().map((m) => m.name).join(', ')}` : ''}${(opts.google?.extraMail?.length ?? 0) > google.extraMail.length ? ' (some extra accounts not signed in; see the log)' : ''}` : opts.google ? 'off (sign-in failed; run npm run google:auth)' : 'off (set GOOGLE_CLIENT_ID to enable)'}`,
      `Notes                 ${vault ? `${vault.root}` : 'off'}`,
      `Saved places          ${places ? `${places.places().length} in ${places.lists().length} list(s), ${opts.places?.apiKey ? 'with hours' : 'no GOOGLE_MAPS_API_KEY, so no hours'}; ${places.store.file}` : 'off (set MAPS_LIST_URLS to enable)'}`,
    ],
    onReady(client) {
      const post = async (channelId: string, content: string, ping: boolean) => {
        const channel = await client.channels.fetch(channelId);
        if (!channel?.isSendable()) throw new Error(`channel ${channelId} is not one I can post in`);
        const parts = splitForDiscord(ping && opts.ownerId ? `<@${opts.ownerId}> ${content}` : content);
        for (const [n, part] of parts.entries()) {
          await channel.send({ content: part, allowedMentions: { users: ping && n === 0 && opts.ownerId ? [opts.ownerId] : [] } });
        }
      };
      tasks.setPoster(post);
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
        const checkBrief = async () => {
          if (sending || !briefState.due(new Date(), opts.timeZone, hour)) return;
          sending = true;
          const started = Date.now();
          try {
            const facts = await briefFacts({ timeZone: opts.timeZone, reminders, journal, tasks, google, places, profile: opts.profile, memory });
            const { text, usage } = await writeBrief(llm, { model: opts.model, effort: 'low' }, facts, opts.profile);
            if (!text) throw new Error('the model wrote nothing');
            const channels = await Promise.all(
              opts.channelIds.map(async (id) => {
                const c = await client.channels.fetch(id).catch(() => null);
                return { id, name: c && 'name' in c ? (c.name ?? undefined) : undefined };
              }),
            );
            await post(briefChannel(briefState, opts.briefChannelId, channels) ?? opts.channelIds[0]!, `☀️ ${text}`, false);
            briefState.sent(new Date(), opts.timeZone);
            activity.record({ kind: 'brief', outcome: 'ok', ms: Date.now() - started, calls: 1, usage });
          } catch (err) {
            console.error('[brief] failed:', err);
            activity.record({ kind: 'brief', outcome: 'error', error: (err instanceof Error ? err.message : String(err)).slice(0, 300) });
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
    },
    async onMessage(message) {
      if (!channels.has(message.channelId) || !isFromOwner(message)) return;
      if (!message.content.trim() && message.attachments.size === 0 && message.messageSnapshots.size === 0) return;
      await enqueue(message.channelId, () => answer(message));
    },
  };
}
