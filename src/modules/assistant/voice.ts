/**
 * Voice notes. Discord voice messages (and any audio file the owner attaches)
 * are transcribed on this machine with the same Whisper model used for
 * reels, and the transcript stands in for the message's text from then on:
 * in the conversation, in later replies, and in the journal.
 *
 * Transcripts are kept in data/voice.json so a restart doesn't turn earlier
 * voice notes back into blanks.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Attachment } from 'discord.js';
import { transcribe, transcriptionEnabled } from './transcribe.js';

/** Longest voice note transcribed; Whisper on the CPU runs at a few times real time. */
export const MAX_VOICE_SECONDS = 10 * 60;
const MAX_VOICE_BYTES = 25 * 1024 * 1024;
const KEEP = 500;
const file = () => process.env.VOICE_FILE?.trim() || fileURLToPath(new URL('../../../data/voice.json', import.meta.url));

type AudioLike = Pick<Attachment, 'id' | 'contentType' | 'name'> & { duration?: number | null; size?: number; url?: string };

/** Whether an attachment is a voice note or other audio. */
export const isAudio = (a: AudioLike) => (a.contentType ?? '').startsWith('audio/') || (a.duration ?? null) !== null;

let cache: Record<string, string> | undefined;
const load = () => (cache ??= existsSync(file()) ? (JSON.parse(readFileSync(file(), 'utf8')) as Record<string, string>) : {});

function save() {
  const all = load();
  const keys = Object.keys(all);
  if (keys.length > KEEP) for (const k of keys.slice(0, keys.length - KEEP)) delete all[k];
  try {
    mkdirSync(dirname(file()), { recursive: true });
    writeFileSync(`${file()}.tmp`, JSON.stringify(all));
    renameSync(`${file()}.tmp`, file());
  } catch (err) {
    console.error('[voice] could not save transcripts:', err);
  }
}

/** Saves a transcript; transcribeAttachment does this, and checks use it directly. */
export function rememberTranscript(id: string, text: string) {
  load()[id] = text;
  save();
}

/** The transcript of an attachment, if it has been transcribed. */
export const transcriptOf = (a: Pick<Attachment, 'id'>): string | undefined => load()[a.id];

/** "[voice note 0:12: …]" for a message's text, or "[voice note]" while it hasn't been transcribed. */
export function voiceLine(a: AudioLike): string {
  const t = transcriptOf(a);
  const len = a.duration ? ` ${Math.floor(a.duration / 60)}:${String(Math.round(a.duration % 60)).padStart(2, '0')}` : '';
  if (t === undefined) return `[voice note${len}]`;
  return t ? `[voice note${len}: "${t}"]` : `[voice note${len}, no speech in it]`;
}

/** Downloads and transcribes an audio attachment, once; later calls return the saved transcript. */
export async function transcribeAttachment(a: AudioLike): Promise<string> {
  const known = transcriptOf(a);
  if (known !== undefined) return known;
  if (!transcriptionEnabled()) throw new Error('speech to text is off on this machine (WHISPER_MODEL=off or no ffmpeg)');
  if (!a.url) throw new Error('the attachment has no link');
  if ((a.duration ?? 0) > MAX_VOICE_SECONDS) throw new Error(`it's over ${MAX_VOICE_SECONDS / 60} minutes long`);
  if ((a.size ?? 0) > MAX_VOICE_BYTES) throw new Error('the file is too big');
  const res = await fetch(a.url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`download failed (${res.status})`);
  const dir = mkdtempSync(join(tmpdir(), 'squire-voice-'));
  try {
    const path = join(dir, 'voice' + (/\.[a-z0-9]{1,5}$/i.exec(a.name ?? '')?.[0] ?? '.ogg'));
    writeFileSync(path, Buffer.from(await res.arrayBuffer()));
    // English, Whisper's default: these are the owner's own notes to the bot.
    const text = await transcribe(path);
    rememberTranscript(a.id, text);
    return text;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
