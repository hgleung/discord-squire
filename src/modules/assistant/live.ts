/**
 * One real round trip to the Claude API, without Discord: asks a question that
 * needs a web search and one that needs a reminder, and prints the replies.
 * Uses ANTHROPIC_API_KEY (and ASSISTANT_MODEL / ASSISTANT_EFFORT) from .env.
 * Reminders go to a temp file, so your real ones are untouched.
 *
 *   npm run check:assistant:live
 */
import 'dotenv/config';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent, type Effort } from './agent.js';
import { AnthropicLLM } from './anthropic.js';
import { buildConversation } from './history.js';
import { ReminderStore } from './reminders.js';
import { systemTimeZone } from './time.js';

const timeZone = process.env.ASSISTANT_TIMEZONE?.trim() || systemTimeZone();
const dir = mkdtempSync(join(tmpdir(), 'squire-live-'));
const reminders = new ReminderStore(join(dir, 'reminders.json'), timeZone);
const agent = new Agent({
  llm: new AnthropicLLM(),
  model: process.env.ASSISTANT_MODEL?.trim() || 'claude-haiku-5-5',
  effort: (process.env.ASSISTANT_EFFORT?.trim() || 'low') as Effort,
  timeZone,
  reminders,
});

async function ask(text: string) {
  const now = new Date();
  const convo = buildConversation([{ authorId: 'me', content: text, createdAt: now, attachments: [] }], {
    botId: 'bot', userId: 'me', channelName: 'misc', timeZone, maxAgeMs: 3600_000,
  });
  const started = Date.now();
  const reply = await agent.reply(convo, { channelId: 'live-check', channelName: 'misc' });
  console.log(`> ${text}\n${reply}\n(${((Date.now() - started) / 1000).toFixed(1)}s)\n`);
}

try {
  await ask("What's the weather looking like in Seattle tomorrow?");
  await ask('Remind me to stretch in 2 hours');
  const set = reminders.list();
  console.log(set.length === 1 ? `Reminder stored: ${set[0]!.due} — ${set[0]!.text}` : `Expected 1 reminder, found ${set.length}`);
  if (set.length !== 1) process.exitCode = 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
