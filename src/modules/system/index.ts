import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { MessageFlags, SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { BotModule } from '../types.js';

const run = promisify(execFile);

/** The checkout the bot runs from. */
const REPO = fileURLToPath(new URL('../../../', import.meta.url));

/**
 * Looking after the bot itself. /update brings the running copy up to date
 * with main on GitHub and restarts it, so a merged pull request goes live
 * without anyone at the PC.
 *
 * The restart is an exit: the Windows launcher (squire.ps1) starts the bot
 * again a few seconds later. Run by hand with npm start, it just stops.
 */
export function systemModule(): BotModule {
  async function git(...args: string[]): Promise<string> {
    const { stdout } = await run('git', args, { cwd: REPO, timeout: 120_000, windowsHide: true });
    return stdout.trim();
  }

  async function update(i: ChatInputCommandInteraction) {
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const say = (text: string) => i.editReply(text.slice(0, 1990));

    const branch = await git('rev-parse', '--abbrev-ref', 'HEAD');
    if (branch !== 'main') return void (await say(`The bot is running the \`${branch}\` branch, not main, so I left it alone. Check out main on the PC first.`));

    await git('fetch', '--quiet', 'origin', 'main');
    const before = await git('rev-parse', 'HEAD');
    const behind = Number(await git('rev-list', '--count', 'HEAD..origin/main'));
    if (behind === 0) return void (await say(`Already up to date (\`${before.slice(0, 7)}\`).`));

    // Refreshing the index first means a file whose only difference is
    // Windows line endings doesn't count as a local change.
    await git('update-index', '-q', '--refresh').catch(() => '');
    const dirty = await git('status', '--porcelain', '--untracked-files=no');
    if (dirty) {
      return void (await say(`There are local changes on the PC, so I didn't update:\n\`\`\`\n${dirty.slice(0, 1200)}\n\`\`\`\nCommit or discard them, then run /update again.`));
    }

    try {
      await git('merge', '--ff-only', '--quiet', 'origin/main');
    } catch (err) {
      return void (await say(`The update couldn't be applied cleanly, so nothing changed: ${err instanceof Error ? err.message.slice(0, 400) : String(err)}`));
    }
    const commits = await git('log', '--oneline', '--no-merges', `${before}..HEAD`);
    const changed = (await git('diff', '--name-only', before, 'HEAD')).split('\n');

    if (changed.includes('package-lock.json')) {
      await say(`Pulled ${behind} commit(s). Installing new packages…`);
      try {
        await run('npm', ['install', '--no-audit', '--no-fund'], { cwd: REPO, timeout: 10 * 60_000, windowsHide: true, shell: process.platform === 'win32' });
      } catch (err) {
        return void (await say(
          `Pulled the code, but \`npm install\` failed, so I didn't restart (the running bot still has the old code loaded):\n${err instanceof Error ? err.message.slice(0, 800) : String(err)}`,
        ));
      }
    }

    console.log(`[update] ${before.slice(0, 7)} → ${(await git('rev-parse', 'HEAD')).slice(0, 7)}; restarting`);
    await say(`Updated to the latest main and restarting now; back in about 10 seconds.\n${commits.split('\n').slice(0, 15).map((c) => `- ${c}`).join('\n')}`);
    // Give Discord a moment to deliver the reply before the process goes.
    setTimeout(() => process.exit(0), 2_000);
  }

  return {
    name: 'system',
    commands: [
      {
        data: new SlashCommandBuilder().setName('update').setDescription('Pull the latest code from GitHub and restart the bot'),
        run: update,
      },
    ],
    describe: () => [`Updates               /update pulls main into ${REPO}`],
  };
}
