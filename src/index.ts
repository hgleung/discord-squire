import { loadConfig } from './config.js';
import { startBot } from './bot.js';
import { trainingModule } from './modules/training/index.js';
import { musicModule } from './modules/music/index.js';
import { assistantModule } from './modules/assistant/index.js';
import { createApp } from './modules/training/http.js';
import { Vault } from './vault.js';

// Last line of defence: a bug in one module must not take the process down.
process.on('unhandledRejection', (reason) => console.error('Unhandled rejection:', reason));
process.on('uncaughtException', (err) => console.error('Uncaught exception:', err));

const config = loadConfig();
const vault = new Vault(config.vault.root, config.vault.folder);

const training = trainingModule({
  trainingDir: vault.abs(vault.own('Training')),
  ollamaHost: config.ollama.host,
  ollamaModel: config.ollama.model,
});

startBot({
  token: config.discord.token,
  ownerId: config.discord.ownerId,
  modules: [
    training,
    musicModule(config.music, config.discord.ownerId),
    ...(config.assistant
      ? [assistantModule({ ...config.assistant, ownerId: config.discord.ownerId, training: training.service, vault })]
      : []),
  ],
});

// The web UI is optional. When enabled it talks to the same store the
// /log command writes to, so the two can never disagree.
if (config.webPort) {
  createApp(training.store).listen(config.webPort, () => {
    console.log(`Web API               http://localhost:${config.webPort}`);
  });
} else {
  console.log('Web API               off (set WEB_PORT to enable the browser UI)');
}
