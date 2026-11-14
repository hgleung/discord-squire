import { Client, Events, GatewayIntentBits, MessageFlags } from 'discord.js';
import type { Guild } from 'discord.js';
import type { BotModule, Command } from './modules/types.js';

export interface BotOptions {
  token: string;
  /** When set, only this user may run any command. */
  ownerId?: string;
  modules: BotModule[];
}

/**
 * Wires modules to Discord. Knows nothing about training logs or music —
 * it registers whatever commands the modules provide and routes interactions
 * to them by name.
 */
export function startBot(opts: BotOptions): Client {
  const commands = new Map<string, Command>();
  for (const mod of opts.modules) {
    for (const cmd of mod.commands) {
      const name = cmd.data.name;
      if (commands.has(name)) throw new Error(`Command /${name} is defined by more than one module.`);
      commands.set(name, cmd);
    }
  }

  // Guilds and GuildVoiceStates (for music) are not privileged. Anything else
  // comes from the modules: the assistant asks for MessageContent, which is
  // privileged and has to be switched on in the Developer Portal, so it is
  // only requested while the assistant is enabled.
  const intents = new Set<GatewayIntentBits>([GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates]);
  for (const mod of opts.modules) for (const intent of mod.intents ?? []) intents.add(intent);
  const client = new Client({ intents: [...intents] });

  /**
   * Guild slash commands are visible to everyone in the server, so ownership
   * is enforced on every interaction rather than by hiding the command list.
   * Autocomplete is gated too, or option lists would leak a module's data.
   */
  const isOwner = (userId: string) => !opts.ownerId || userId === opts.ownerId;
  const mayRun = (cmd: Command | undefined, userId: string) => cmd?.public === true || isOwner(userId);

  // Guild-scoped commands register instantly; global ones can take an hour.
  // Registering per guild (rather than once, globally) also means the bot
  // can be in several servers at once, and leaving one clears its commands
  // there immediately, with nothing to clean up.
  const payload = [...commands.values()].map((c) => c.data.toJSON());
  const registerIn = (guild: Guild) => guild.commands.set(payload);

  // Events.ClientReady, not the 'ready' string: discord.js v15 drops the old
  // name, and the gateway READY event is a different thing entirely.
  client.once(Events.ClientReady, async () => {
    console.log(`Logged in as          ${client.user?.tag}`);
    const guilds = [...client.guilds.cache.values()];
    await Promise.all(guilds.map((g) => registerIn(g)));
    console.log(`Commands registered   ${commands.size} in ${guilds.map((g) => g.name).join(', ') || '(no servers yet)'}`);
    console.log(`Access                ${opts.ownerId ? `restricted to user ${opts.ownerId}` : 'open to the whole server'}`);
    for (const mod of opts.modules) {
      for (const line of mod.describe?.() ?? []) console.log(line);
    }
    for (const mod of opts.modules) mod.onReady?.(client as Client<true>);
  });

  const listeners = opts.modules.filter((m) => m.onMessage);
  if (listeners.length > 0) {
    client.on(Events.MessageCreate, (message) => {
      for (const mod of listeners) {
        mod.onMessage!(message).catch((err) => console.error(`[${mod.name}] message handler failed:`, err));
      }
    });
  }

  // Registers commands the moment the bot joins a new server, so an invite
  // link works right away instead of needing a restart.
  client.on(Events.GuildCreate, async (guild) => {
    await registerIn(guild);
    console.log(`Commands registered   ${commands.size} in ${guild.name} (just joined)`);
  });

  client.on(Events.InteractionCreate, async (i) => {
    try {
      if (i.isAutocomplete()) {
        const cmd = commands.get(i.commandName);
        if (!mayRun(cmd, i.user.id)) return void (await i.respond([]));
        await cmd?.autocomplete?.(i);
        return;
      }
      if (!i.isChatInputCommand()) return;

      const cmd = commands.get(i.commandName);
      if (!cmd) return;
      if (!mayRun(cmd, i.user.id)) {
        await i.reply({ content: 'This command is owner-only.', flags: MessageFlags.Ephemeral });
        return;
      }
      // Awaited, not returned: returning the promise would hand it back before
      // it rejects, so the catch below would never see the failure.
      await cmd.run(i);
    } catch (err) {
      console.error(`/${i.isChatInputCommand() ? i.commandName : 'interaction'} failed:`, err);
      const content = `⚠️ ${err instanceof Error ? err.message : String(err)}`;
      if (i.isRepliable()) {
        if (i.deferred || i.replied) await i.editReply(content).catch(() => {});
        else await i.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
      }
    }
  });

  // A command failure must never kill the process; other modules and the
  // optional web API live here too.
  client.on(Events.Error, (err) => console.error('Discord client error:', err));

  client.login(opts.token).catch((err) => {
    // The usual cause once the assistant is on: Message Content Intent is
    // still off in the Developer Portal, which Discord reports this way.
    if (err instanceof Error && /disallowed intents/i.test(err.message)) {
      console.error(
        'Discord refused the requested intents. Turn on "Message Content Intent" under ' +
          'Developer Portal → your app → Bot → Privileged Gateway Intents, or clear ASSISTANT_CHANNEL_IDS.',
      );
    } else {
      console.error('Discord login failed:', err);
    }
    process.exit(1);
  });
  return client;
}
