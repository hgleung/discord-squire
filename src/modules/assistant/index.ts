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
import { discordReader, openLinks } from './discordLinks.js';
import { ReminderStore } from './reminders.js';
import { TaskRunner, TaskStore } from './tasks.js';
import { MemoryStore } from './memory.js';
import { SavedPlaces } from './places.js';
import { tripDigests } from './placesTools.js';
import { toLocalIso, toLocalShort } from './time.js';

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
  // Configured but never signed in, or the token file is unreadable: carry on
  // without Gmail rather than refuse to start.
  let google: GoogleAccount | undefined;
  if (opts.google) {
    try {
      google = new GoogleAccount(opts.google);
    } catch (err) {
      console.error(`[assistant] Gmail and Calendar are off: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const { vault } = opts;
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
    places,
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
    places,
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
    try {
      const recent = await channel.messages.fetch({ limit: HISTORY_LIMIT });
      const sorted = [...recent.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
      let lines: ChatLine[] = sorted.map((m) => ({
        id: m.id,
        replyToId: m.reference?.messageId,
        authorId: m.author.id,
        content: m.content,
        createdAt: m.createdAt,
        attachments: [...m.attachments.values()].map((a) => ({ url: a.url, contentType: a.contentType, name: a.name })),
      }));
      // Open what the messages being answered carry: their images, short
      // links, and Discord links. Older lines keep just their text.
      const reader = discordReader(message.client, opts.ownerId, opts.timeZone);
      const ids = { botId: message.client.user.id, userId: message.author.id };
      const opened = new Map<string, ChatLine>();
      const shot = recentScreenshot(lines, ids);
      for (const line of [...unanswered(lines, ids), ...(shot ? [shot] : [])]) {
        const m = recent.get(line.id!);
        if (m) opened.set(line.id!, await openLinks(m, line, reader));
      }
      lines = lines.map((l) => opened.get(l.id!) ?? l);
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

      const text = await agent.reply(conversation, { channelId: channel.id, channelName, discord: reader });
      const [first, ...rest] = splitForDiscord(text);
      if (first) await message.reply({ content: first, allowedMentions: { repliedUser: false } });
      for (const part of rest) await channel.send({ content: part, allowedMentions: { parse: [] } });
    } catch (err) {
      console.error('[assistant] reply failed:', err);
      const detail = err instanceof Error ? err.message : String(err);
      await message.reply({ content: `⚠️ I couldn't answer that: ${detail.slice(0, 300)}`, allowedMentions: { repliedUser: false } }).catch(() => {});
    } finally {
      clearInterval(typing);
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

  return {
    name: 'assistant',
    commands: [remindersCommand, tasksCommand, memoriesCommand],
    intents: [GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    describe: () => [
      `Assistant             ${opts.model} (effort ${opts.effort}) in ${opts.channelIds.length} channel(s)`,
      `Background tasks use  ${opts.taskModel}, or ${opts.model} for simple ones`,
      `Reminders             ${reminders.list().length} pending in ${reminders.file} (${opts.timeZone})`,
      `Background tasks      ${tasks.active().length} unfinished in ${opts.tasksFile}`,
      `Memory                ${memory.list().length} memories in ${memory.file}`,
      `Gmail and Calendar    ${google ? 'on' : opts.google ? 'off (sign-in failed; run npm run google:auth)' : 'off (set GOOGLE_CLIENT_ID to enable)'}`,
      `Notes                 ${vault ? `${vault.root} (writes to ${vault.folder}/)` : 'off'}`,
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
      if (!message.content.trim() && message.attachments.size === 0) return;
      await enqueue(message.channelId, () => answer(message));
    },
  };
}
