import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { AutocompleteInteraction } from 'discord.js';
import type { BotModule, Command } from '../types.js';
import { PlanStore } from './store.js';
import { TrainingError, TrainingService } from './service.js';
import { getOrEmptyDay, getWeekDays } from '../../../lib/planOps.js';
import { buildWeekInput, generateWeekSummary } from '../../../lib/weekSummary.js';
import type { PlanData } from '../../../lib/types.js';

export interface TrainingOptions {
  /** The training folder in the vault (Training.md and Splits/), e.g. ".../Vault/Training". */
  trainingDir: string;
  /** Where the workout notes go, e.g. ".../Vault/Squire/Workouts"; Workouts/ in the training folder by default. */
  workoutsDir?: string;
  ollamaHost: string;
  ollamaModel: string;
}

export function trainingModule(opts: TrainingOptions): BotModule & { store: PlanStore; service: TrainingService } {
  const store = new PlanStore(opts.trainingDir, opts.workoutsDir);
  const service = new TrainingService(store);
  const today = () => service.today();
  const ensurePlan = () => service.ensurePlan();

  /** A TrainingError is the user's mistake, so it's a private note, not a failure. */
  const replyOrRefuse = async (i: import('discord.js').ChatInputCommandInteraction, work: () => string) => {
    try {
      await i.reply(work());
    } catch (err) {
      if (!(err instanceof TrainingError)) throw err;
      await i.reply({ content: err.message, flags: MessageFlags.Ephemeral });
    }
  };

  /** Autocomplete stays read-only: it must not create the training log. */
  const suggest = async (i: AutocompleteInteraction, names: (plan: PlanData) => string[]) => {
    const typed = i.options.getFocused().toLowerCase();
    try {
      await i.respond(
        names(store.load())
          .filter((n) => n.toLowerCase().includes(typed))
          .slice(0, 25)
          .map((n) => ({ name: n, value: n })),
      );
    } catch {
      await i.respond([]);
    }
  };

  const todayCmd: Command = {
    data: new SlashCommandBuilder().setName('today').setDescription("Show today's session"),
    async run(i) {
      await i.reply(service.session());
    },
  };

  const log: Command = {
    data: new SlashCommandBuilder()
      .setName('log')
      .setDescription('Log a completed set')
      .addStringOption((o) => o.setName('exercise').setDescription('Exercise').setRequired(true).setAutocomplete(true))
      .addNumberOption((o) => o.setName('weight').setDescription('Weight').setRequired(true).setMinValue(0))
      .addIntegerOption((o) => o.setName('reps').setDescription('Reps').setRequired(true).setMinValue(1)),
    async run(i) {
      const name = i.options.getString('exercise', true);
      const weight = i.options.getNumber('weight', true);
      const reps = i.options.getInteger('reps', true);
      await replyOrRefuse(i, () => service.logSet(name, weight, reps));
    },
    autocomplete: (i) => suggest(i, (plan) => getOrEmptyDay(plan, today()).exercises.map((e) => e.name)),
  };

  const split: Command = {
    data: new SlashCommandBuilder()
      .setName('split')
      .setDescription("Load a split into today's session")
      .addStringOption((o) => o.setName('name').setDescription('Which split').setRequired(true).setAutocomplete(true)),
    async run(i) {
      const name = i.options.getString('name', true);
      await replyOrRefuse(i, () => service.loadSplit(name));
    },
    autocomplete: (i) => suggest(i, (plan) => plan.templates.map((t) => t.name)),
  };

  const splits: Command = {
    data: new SlashCommandBuilder().setName('splits').setDescription('List available splits'),
    async run(i) {
      await i.reply(service.splits());
    },
  };

  const week: Command = {
    data: new SlashCommandBuilder().setName('week').setDescription('AI summary of this training week'),
    async run(i) {
      await i.deferReply(); // local model generation exceeds Discord's 3s reply window
      const plan = ensurePlan();
      const date = today();
      const weekDays = getWeekDays(plan, date);
      if (!weekDays.some((d) => d.exercises.length > 0)) {
        await i.editReply('Nothing logged this week yet.');
        return;
      }
      const s = await generateWeekSummary(buildWeekInput(plan, weekDays, date), opts.ollamaHost, opts.ollamaModel);
      await i.editReply(
        [`**${s.headline}**`, '', `**Effort** — ${s.effort}`, '', `**Improvement** — ${s.improvement}`, '', `**Next week** — ${s.focus}`].join('\n'),
      );
    },
  };

  return {
    name: 'training',
    commands: [todayCmd, log, split, splits, week],
    describe: () => [
      `Training log         ${store.file}, workouts in ${store.workoutsFolder}${store.exists() ? '' : '  (will be created on first save)'}`,
      `Summaries            ${opts.ollamaModel} via ${opts.ollamaHost}`,
    ],
    store,
    service,
  };
}
