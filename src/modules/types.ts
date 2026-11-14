import type {
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  Client,
  GatewayIntentBits,
  Message,
  SlashCommandBuilder,
  SlashCommandOptionsOnlyBuilder,
  SlashCommandSubcommandsOnlyBuilder,
} from 'discord.js';

/** Anything the builder API hands back once options are attached. */
export type CommandData = SlashCommandBuilder | SlashCommandOptionsOnlyBuilder | SlashCommandSubcommandsOnlyBuilder;

/**
 * One slash command. `run` is awaited by the dispatcher inside a try/catch, so
 * throwing is the right way to report a failure — it becomes the reply.
 */
export interface Command {
  data: CommandData;
  run(interaction: ChatInputCommandInteraction): Promise<void>;
  autocomplete?(interaction: AutocompleteInteraction): Promise<void>;
  /**
   * Usable by anyone in the server, bypassing DISCORD_ADMIN_ID. Default is
   * owner-only. Reserve for commands whose effect is harmless to the owner —
   * queueing a song, not deleting a workout.
   */
  public?: boolean;
}

/**
 * A feature of the bot — a directory under src/modules that owns some
 * commands and whatever state they need. The bot registers every module's
 * commands together; modules never see each other.
 */
export interface BotModule {
  name: string;
  commands: Command[];
  /** Printed at startup, e.g. which file or model the module is using. */
  describe?(): string[];
  /**
   * Gateway intents beyond Guilds that this module needs. The bot only asks
   * Discord for the union of what its modules declare, so a privileged intent
   * like MessageContent is requested only while a module that reads messages
   * is switched on.
   */
  intents?: GatewayIntentBits[];
  /** Called once the client is logged in, e.g. to start a timer that posts. */
  onReady?(client: Client<true>): void;
  /**
   * Every message the bot can see, other bots' included. The module decides
   * what to answer; a throw is logged, never shown.
   */
  onMessage?(message: Message): Promise<void>;
}
