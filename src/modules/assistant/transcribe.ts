/**
 * Speech to text on the bot's own machine, for videos that come without
 * captions (Instagram reels, TikToks). Whisper runs on the CPU through
 * transformers.js; the model is downloaded once on first use and kept in
 * data/models.
 */
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import ffmpegPath from 'ffmpeg-static';

const run = promisify(execFile);

const SAMPLE_RATE = 16_000;
/** The model is let go after this long unused, to give back its memory. */
const IDLE_MS = 15 * 60_000;
const CACHE_DIR = fileURLToPath(new URL('../../../data/models', import.meta.url));

/** WHISPER_MODEL picks the model (any transformers.js Whisper export); "off" turns transcription off. */
export const WHISPER_MODEL = process.env.WHISPER_MODEL?.trim() || 'onnx-community/whisper-small';
export const transcriptionEnabled = () => WHISPER_MODEL.toLowerCase() !== 'off' && !!ffmpegPath;

type Recognizer = (audio: Float32Array, opts: Record<string, unknown>) => Promise<{ text: string } | { text: string }[]>;

let loading: Promise<Recognizer> | undefined;
let idle: NodeJS.Timeout | undefined;
// One transcription at a time: two at once only slow each other down.
let queue: Promise<unknown> = Promise.resolve();

async function recognizer(): Promise<Recognizer> {
  loading ??= (async () => {
    const { pipeline, env } = await import('@huggingface/transformers');
    env.cacheDir = CACHE_DIR;
    const asr = await pipeline('automatic-speech-recognition', WHISPER_MODEL, { dtype: 'q8' });
    return asr as unknown as Recognizer;
  })();
  loading.catch(() => (loading = undefined));
  return loading;
}

function release() {
  clearTimeout(idle);
  idle = setTimeout(() => {
    const done = loading;
    loading = undefined;
    void done?.then((asr) => (asr as unknown as { dispose?: () => Promise<void> }).dispose?.()).catch(() => {});
  }, IDLE_MS);
  idle.unref();
}

/** A media file's audio as 16 kHz mono samples, the form Whisper takes. */
export async function decodeAudio(file: string): Promise<Float32Array> {
  if (!ffmpegPath) throw new Error('ffmpeg is not available');
  const { stdout } = await run(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-i', file, '-vn', '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 'f32le', 'pipe:1'], {
    encoding: 'buffer',
    maxBuffer: 1 << 30,
    timeout: 120_000,
  });
  // Copied so the samples start on a 4-byte boundary.
  return new Float32Array(new Uint8Array(stdout).buffer);
}

/** Loudest stretch in the audio; near-silent files (music beds, no voice) are skipped. */
export function peak(samples: Float32Array): number {
  let max = 0;
  for (let i = 0; i < samples.length; i += 16) max = Math.max(max, Math.abs(samples[i]!));
  return max;
}

/**
 * Whisper's output with its known slips removed: the "[Music]" style tags it
 * writes for sound that isn't speech (a transcript of nothing but those means
 * no one spoke), and the loops it falls into over music, where one word or
 * phrase repeats dozens of times.
 */
export function cleanTranscript(text: string): string {
  const stripped = text.replace(/\[[^\]]*\]|\([^)]*\)|[♪♫]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!stripped || /^(?:(?:music|applause|laughter|silence|instrumental|you|thank you)[\s.,!]*)+$/i.test(stripped)) return '';
  return stripped.replace(/([^\s,.]+(?:\s+[^\s,.]+){0,5}?)(?:[\s,.]+\1(?=[\s,.!?]|$)){3,}[,.]?/gu, '$1 [repeated]');
}

/**
 * What's said in a media file. `language` is the spoken language's English
 * name ("korean"); without one Whisper assumes English.
 */
export async function transcribe(file: string, language?: string): Promise<string> {
  const job = queue.then(async () => {
    const audio = await decodeAudio(file);
    if (audio.length < SAMPLE_RATE / 2 || peak(audio) < 0.01) return '';
    const asr = await recognizer();
    try {
      const out = await asr(audio, {
        chunk_length_s: 30,
        stride_length_s: 5,
        task: 'transcribe',
        ...(language ? { language: language.toLowerCase() } : {}),
      });
      return cleanTranscript(Array.isArray(out) ? out.map((o) => o.text).join(' ') : out.text);
    } finally {
      release();
    }
  });
  queue = job.catch(() => {});
  return job;
}

