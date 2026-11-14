import { MessageFlags, SlashCommandBuilder, escapeMarkdown as md } from 'discord.js';
import type { ChatInputCommandInteraction } from 'discord.js';
import type { BotModule, Command } from '../types.js';
import { GuildPlayer, configureYtdlp, formatDuration, resolveTracks, type YtdlpAuth } from './player.js';

export function musicModule(auth: YtdlpAuth = {}, ownerId?: string): BotModule {
  configureYtdlp(auth);
  const players = new Map<string, GuildPlayer>();
  const playerFor = (guildId: string) => {
    let p = players.get(guildId);
    if (!p) {
      p = new GuildPlayer((msg) => console.error(`[music ${guildId}] ${msg}`));
      players.set(guildId, p);
    }
    return p;
  };

  const nothingPlaying = (i: ChatInputCommandInteraction) =>
    i.reply({ content: 'Nothing is playing.', flags: MessageFlags.Ephemeral });

  const play: Command = {
    public: true, // anyone in the channel can add to the queue
    data: new SlashCommandBuilder()
      .setName('play')
      .setDescription('Play or queue YouTube audio in your voice channel')
      .addStringOption((o) => o.setName('query').setDescription('YouTube link or search text').setRequired(true)),
    async run(i) {
      const member = i.guild?.members.cache.get(i.user.id) ?? (await i.guild?.members.fetch(i.user.id));
      const channel = member?.voice.channel;
      if (!channel) {
        await i.reply({ content: 'Join a voice channel first.', flags: MessageFlags.Ephemeral });
        return;
      }

      await i.deferReply(); // resolving through yt-dlp can exceed the 3s reply window
      const query = i.options.getString('query', true);
      const tracks = await resolveTracks(query, i.user.username);
      if (tracks.length === 0) {
        await i.editReply(`Nothing found for **${md(query)}**.`);
        return;
      }

      const player = playerFor(i.guildId!);
      // Later failures (a track that 403s, an auth misconfiguration, etc.) need
      // somewhere to be reported; the interaction token expires by then. Those
      // messages can leak internal detail (yt-dlp stderr, cookie paths), so
      // they go to the owner's DMs, not the channel — /play is open to anyone.
      // With no owner configured there's no single person to DM, so fall back
      // to the channel; same if the DM itself fails (e.g. the owner has DMs off).
      const textChannel = i.channel;
      const toChannel = textChannel?.isSendable() ? (m: string) => textChannel.send(m) : null;
      player.notify = ownerId
        ? async (m) => {
            try {
              const owner = await i.client.users.fetch(ownerId);
              return await owner.send(m);
            } catch (err) {
              console.error('[music] failed to DM owner, falling back to channel:', err);
              return toChannel?.(m);
            }
          }
        : toChannel;
      await player.join(channel);
      const wasIdle = !player.current;
      player.enqueue(tracks);

      if (tracks.length > 1) {
        await i.editReply(`Queued **${tracks.length}** tracks from that playlist.`);
      } else {
        const t = tracks[0];
        await i.editReply(
          wasIdle
            ? `▶️ **${md(t.title)}** (${formatDuration(t.duration)})`
            : `Queued **${md(t.title)}** (${formatDuration(t.duration)}) — position ${player.queue.length}.`,
        );
      }
    },
  };

  const skip: Command = {
    public: true,
    data: new SlashCommandBuilder()
      .setName('skip')
      .setDescription('Skip the current track')
      .addIntegerOption((o) => o.setName('count').setDescription('How many to skip (default 1)').setMinValue(1)),
    async run(i) {
      const player = players.get(i.guildId!);
      if (!player?.current) return void (await nothingPlaying(i));
      const n = player.skip(i.options.getInteger('count') ?? 1);
      await i.reply(n === 1 ? '⏭️ Skipped.' : `⏭️ Skipped ${n} tracks.`);
    },
  };

  const queue: Command = {
    public: true, // if anyone can add, anyone should be able to see
    data: new SlashCommandBuilder().setName('queue').setDescription("What's coming up"),
    async run(i) {
      const player = players.get(i.guildId!);
      if (!player?.current) return void (await nothingPlaying(i));
      const lines = [
        `▶️ **${md(player.current.title)}** (${formatDuration(player.current.duration)})${player.loop ? ' 🔁' : ''}`,
        ...player.queue.slice(0, 10).map((t, n) => `${n + 1}. ${md(t.title)} (${formatDuration(t.duration)})`),
      ];
      if (player.queue.length > 10) lines.push(`…and ${player.queue.length - 10} more`);
      await i.reply(lines.join('\n'));
    },
  };

  const loop: Command = {
    public: true,
    data: new SlashCommandBuilder().setName('loop').setDescription('Toggle looping the current track'),
    async run(i) {
      const player = players.get(i.guildId!);
      if (!player?.current) return void (await nothingPlaying(i));
      player.setLoop(!player.loop);
      await i.reply(player.loop ? `🔁 Looping **${md(player.current.title)}**.` : 'Loop off.');
    },
  };

  const shuffle: Command = {
    public: true,
    data: new SlashCommandBuilder().setName('shuffle').setDescription('Shuffle the queued tracks'),
    async run(i) {
      const player = players.get(i.guildId!);
      if (!player?.current) return void (await nothingPlaying(i));
      const n = player.shuffle();
      await i.reply(n < 2 ? 'Nothing to shuffle yet.' : `🔀 Shuffled ${n} tracks.`);
    },
  };

  const move: Command = {
    public: true,
    data: new SlashCommandBuilder()
      .setName('move')
      .setDescription('Move a queued track to play next, or last')
      .addIntegerOption((o) =>
        o.setName('position').setDescription('Its number in /queue').setRequired(true).setMinValue(1),
      )
      .addStringOption((o) =>
        o.setName('to').setDescription('Where to').setRequired(true)
          .addChoices({ name: 'front (play next)', value: 'front' }, { name: 'back (play last)', value: 'back' }),
      ),
    async run(i) {
      const player = players.get(i.guildId!);
      if (!player?.current) return void (await nothingPlaying(i));
      const position = i.options.getInteger('position', true);
      const to = i.options.getString('to', true) as 'front' | 'back';
      const track = player.move(position, to);
      if (!track) {
        await i.reply({ content: `No track at position ${position} — the queue has ${player.queue.length}.`, flags: MessageFlags.Ephemeral });
        return;
      }
      await i.reply(to === 'front' ? `⏫ **${md(track.title)}** plays next.` : `⏬ **${md(track.title)}** moved to the end.`);
    },
  };

  const remove: Command = {
    public: true,
    data: new SlashCommandBuilder()
      .setName('remove')
      .setDescription('Remove a track from the queue')
      .addIntegerOption((o) =>
        o.setName('position').setDescription('Its number in /queue').setRequired(true).setMinValue(1),
      ),
    async run(i) {
      const player = players.get(i.guildId!);
      if (!player?.current) return void (await nothingPlaying(i));
      const position = i.options.getInteger('position', true);
      const track = player.remove(position);
      if (!track) {
        await i.reply({ content: `No track at position ${position} — the queue has ${player.queue.length}.`, flags: MessageFlags.Ephemeral });
        return;
      }
      await i.reply(`🗑️ Removed **${md(track.title)}**.`);
    },
  };

  const clear: Command = {
    public: true,
    data: new SlashCommandBuilder().setName('clear').setDescription('Empty the queue; the current track keeps playing'),
    async run(i) {
      const player = players.get(i.guildId!);
      if (!player?.current) return void (await nothingPlaying(i));
      const n = player.clear();
      await i.reply(n === 0 ? 'The queue was already empty.' : `🧹 Cleared ${n} queued track${n === 1 ? '' : 's'}.`);
    },
  };

  const stop: Command = {
    public: true,
    data: new SlashCommandBuilder().setName('stop').setDescription('Clear the queue and leave the voice channel'),
    async run(i) {
      const player = players.get(i.guildId!);
      if (!player?.connected) {
        await i.reply({ content: "I'm not in a voice channel.", flags: MessageFlags.Ephemeral });
        return;
      }
      player.stop();
      await i.reply('⏹️ Stopped and left the channel.');
    },
  };

  const playbackCommands = [play, skip, queue, loop, shuffle, move, remove, clear, stop];

  const musicHelp: Command = {
    public: true,
    data: new SlashCommandBuilder().setName('music-help').setDescription('List what the music commands do'),
    async run(i) {
      // Built from each command's own name/description/options rather than a
      // separate written-out list, so it can't drift out of sync with them.
      const lines = playbackCommands.map((c) => {
        const json = c.data.toJSON();
        const usage = (json.options ?? []).map((o) => (o.required ? `<${o.name}>` : `[${o.name}]`)).join(' ');
        return `**/${json.name}**${usage ? ` ${usage}` : ''} — ${json.description}`;
      });
      await i.reply({
        content: [...lines, '', 'Positions in `/move` and `/remove` are the numbers `/queue` shows.'].join('\n'),
        flags: MessageFlags.Ephemeral,
      });
    },
  };

  return {
    name: 'music',
    commands: [...playbackCommands, musicHelp],
    describe: () => [
      `YouTube auth          ${auth.cookies ? `cookies from ${auth.cookies}` : auth.cookiesFromBrowser ? `cookies from ${auth.cookiesFromBrowser}` : 'none (age-restricted videos will be skipped)'}`,
    ],
  };
}
