import 'dotenv/config';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { systemTimeZone } from './modules/assistant/time.js';
import { EFFORTS, type Effort, type OwnerProfile } from './modules/assistant/llm.js';
import type { GoogleConfig } from './modules/assistant/google.js';

export interface Config {
  discord: {
    token: string;
    /** When set, only this user may run any command. */
    ownerId?: string;
  };
  /** The Obsidian vault: the training log lives in it, and the assistant reads and writes notes there. */
  vault: {
    root: string;
    /** Squire's own folder inside the vault. */
    folder: string;
  };
  ollama: {
    host: string;
    model: string;
  };
  music: {
    /** Path to a cookies.txt so yt-dlp can play age-restricted videos. */
    cookies?: string;
    /** Or read YouTube cookies straight from a browser profile, e.g. "chrome". */
    cookiesFromBrowser?: string;
  };
  /** Port for the optional web UI's API; the UI is off when unset. */
  webPort?: number;
  /** The chat assistant; off when no channels are listed. */
  assistant?: {
    channelIds: string[];
    /** Chat replies, and fast-tier background tasks. */
    model: string;
    /** Capable-tier background tasks. */
    taskModel: string;
    effort: Effort;
    timeZone: string;
    remindersFile: string;
    tasksFile: string;
    memoryFile: string;
    profile: OwnerProfile;
    /** Gmail and Calendar; off unless an OAuth client is configured. */
    google?: GoogleConfig;
    /** Saved Google Maps lists; off unless share links are listed. */
    places?: { listUrls: string[]; apiKey?: string; file: string; home?: string };
  };
}

/** "Springfield, OR" or "Springfield, OR, US" → parts; the country defaults to US. */
function parseLocation(value: string | undefined, timezone: string): OwnerProfile['location'] {
  if (!value) return undefined;
  const [city, region, country] = value.split(',').map((p) => p.trim()).filter(Boolean);
  return { city, region, country: (country ?? 'US').toUpperCase(), timezone };
}

function loadAssistant(): Config['assistant'] {
  const channelIds = (optional('ASSISTANT_CHANNEL_IDS') ?? '')
    .split(/[\s,]+/)
    .map((id) => id.trim())
    .filter(Boolean);
  if (channelIds.length === 0) return undefined;
  if (!optional('ANTHROPIC_API_KEY')) {
    console.error('ASSISTANT_CHANNEL_IDS is set but ANTHROPIC_API_KEY is not; the assistant needs both. Add the key to .env.');
    process.exit(1);
  }
  const effort = (optional('ASSISTANT_EFFORT') ?? 'low') as Effort;
  if (!EFFORTS.includes(effort)) {
    console.error(`ASSISTANT_EFFORT must be one of ${EFFORTS.join(', ')}.`);
    process.exit(1);
  }
  const timeZone = optional('ASSISTANT_TIMEZONE') ?? systemTimeZone();
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
  } catch {
    console.error(`ASSISTANT_TIMEZONE "${timeZone}" is not a time zone name, e.g. America/Los_Angeles.`);
    process.exit(1);
  }
  const clientId = optional('GOOGLE_CLIENT_ID');
  const listUrls = (optional('MAPS_LIST_URLS') ?? '').split(/[\s,]+/).filter(Boolean);
  const clientSecret = optional('GOOGLE_CLIENT_SECRET');
  return {
    channelIds,
    model: optional('ASSISTANT_MODEL') ?? 'claude-haiku-5-5',
    taskModel: optional('ASSISTANT_TASK_MODEL') ?? 'claude-sonnet-5-5',
    effort,
    timeZone,
    // Next to the code by default, not the working directory, so it's the
    // same file however the bot is launched (a startup task included).
    remindersFile: optional('REMINDERS_FILE') ?? fileURLToPath(new URL('../data/reminders.json', import.meta.url)),
    tasksFile: optional('TASKS_FILE') ?? fileURLToPath(new URL('../data/tasks.json', import.meta.url)),
    memoryFile: optional('MEMORY_FILE') ?? fileURLToPath(new URL('../data/memory.json', import.meta.url)),
    profile: { location: parseLocation(optional('ASSISTANT_LOCATION'), timeZone), about: optional('ASSISTANT_ABOUT_ME') },
    google:
      clientId && clientSecret
        ? { clientId, clientSecret, tokenFile: optional('GOOGLE_TOKEN_FILE') ?? fileURLToPath(new URL('../data/google-token.json', import.meta.url)) }
        : undefined,
    places: listUrls.length
      ? {
          listUrls,
          apiKey: optional('GOOGLE_MAPS_API_KEY'),
          file: optional('PLACES_FILE') ?? fileURLToPath(new URL('../data/places.json', import.meta.url)),
          home: optional('ASSISTANT_LOCATION'),
        }
      : undefined,
  };
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`Missing ${name}. Copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
  return value;
}

function optional(name: string): string | undefined {
  return process.env[name]?.trim() || undefined;
}

export function loadConfig(): Config {
  const webPort = optional('WEB_PORT');
  // The vault is created by Obsidian, not by us: a typo here should stop the
  // bot, not quietly start a second "vault" nobody syncs.
  const vaultRoot = required('OBSIDIAN_VAULT');
  if (!existsSync(vaultRoot)) {
    console.error(`OBSIDIAN_VAULT "${vaultRoot}" doesn't exist. Point it at your Obsidian vault folder.`);
    process.exit(1);
  }
  return {
    discord: {
      token: required('DISCORD_TOKEN'),
      ownerId: optional('DISCORD_ADMIN_ID'),
    },
    vault: {
      root: vaultRoot,
      folder: optional('OBSIDIAN_FOLDER') ?? 'Squire',
    },
    ollama: {
      host: optional('OLLAMA_HOST') ?? 'http://localhost:11434',
      model: optional('OLLAMA_MODEL') ?? 'qwen2.5:7b',
    },
    music: {
      cookies: optional('YOUTUBE_COOKIES'),
      cookiesFromBrowser: optional('YOUTUBE_COOKIES_FROM_BROWSER'),
    },
    webPort: webPort ? Number(webPort) : undefined,
    assistant: loadAssistant(),
  };
}
