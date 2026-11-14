/**
 * Reading a video link (YouTube, Instagram, TikTok and anything else yt-dlp
 * knows) without watching it: the title, the creator's description or
 * caption, a transcript (its captions, or the audio transcribed on the PC
 * when it has none), and for short videos a few frames, since recipe reels
 * often put the ingredients on screen and nowhere else.
 */
import { execFile } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import youtubedl from 'youtube-dl-exec';
import ffmpegPath from 'ffmpeg-static';
import { ytdlpFlags } from '../music/player.js';
import type { ImagePart, ToolHandler } from './llm.js';
import { assertPublic, decodeEntities, findUrls, parseDiscordLink } from './links.js';
import { transcribe, transcriptionEnabled } from './transcribe.js';

const run = promisify(execFile);

/** Videos up to this long also get frames; longer ones are covered by their transcript. */
const FRAME_MAX_SECONDS = 4 * 60;
/** With no transcript, frames are all there is, so longer videos get them too. */
const FRAME_MAX_SECONDS_SILENT = 15 * 60;
const FRAME_COUNT = 8;
const MAX_DOWNLOAD = '60M';
const MAX_TRANSCRIPT_CHARS = 30_000;
const MAX_DESCRIPTION_CHARS = 8_000;

interface CaptionFormat {
  ext: string;
  url: string;
}

export interface VideoInfo {
  title?: string;
  uploader?: string;
  channel?: string;
  duration?: number;
  description?: string;
  webpage_url?: string;
  chapters?: { title: string; start_time: number }[];
  subtitles?: Record<string, CaptionFormat[]>;
  automatic_captions?: Record<string, CaptionFormat[]>;
  _type?: string;
}

/**
 * The captions to read: the uploader's own in English first, then YouTube's
 * automatic English ones ("en-orig" is the spoken track, not a translation),
 * then whatever language there is.
 */
export function pickCaptions(info: VideoInfo): { lang: string; auto: boolean; format: CaptionFormat } | undefined {
  const sources: [Record<string, CaptionFormat[]> | undefined, boolean][] = [
    [info.subtitles, false],
    [info.automatic_captions, true],
  ];
  for (const preferEnglish of [true, false]) {
    for (const [tracks, auto] of sources) {
      const langs = Object.keys(tracks ?? {}).filter((l) => l !== 'live_chat');
      const ordered = preferEnglish ? ['en-orig', 'en', ...langs.filter((l) => /^en\b/.test(l))].filter((l) => langs.includes(l)) : langs;
      // Automatic captions list every translation; only the original is worth reading.
      const candidates = auto && !preferEnglish ? ordered.filter((l) => l.endsWith('-orig')) : ordered;
      for (const lang of candidates) {
        const formats = tracks![lang]!;
        const format = formats.find((f) => f.ext === 'json3') ?? formats.find((f) => f.ext === 'vtt');
        if (format) return { lang, auto, format };
      }
    }
  }
  return undefined;
}

/** Caption text, one line per cue with repeats dropped (auto captions repeat each line as it scrolls). */
export function captionText(body: string, ext: string): string {
  let lines: string[];
  if (ext === 'json3') {
    const data = JSON.parse(body) as { events?: { segs?: { utf8?: string }[] }[] };
    lines = (data.events ?? []).map((e) => (e.segs ?? []).map((s) => s.utf8 ?? '').join(''));
  } else {
    lines = body
      .split(/\r?\n/)
      .filter((l) => l && !/^(WEBVTT|Kind:|Language:|NOTE)/.test(l) && !l.includes('-->') && !/^\d+$/.test(l))
      .map((l) => l.replace(/<[^>]+>/g, ''));
  }
  const out: string[] = [];
  for (const raw of lines) {
    const line = decodeEntities(raw).replace(/\s+/g, ' ').trim();
    if (line && line !== out.at(-1)) out.push(line);
  }
  return out.join(' ');
}

const clip = (s: string, max: number, what: string) => (s.length > max ? `${s.slice(0, max)} […${what} cut short]` : s);

const timestamp = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/** The text half of a video's reading: who, what, the description and the transcript. */
export function describeVideo(info: VideoInfo, transcript: string | undefined, captionNote: string): string {
  const lines = [
    `Video: ${info.title ?? '(untitled)'}`,
    info.uploader || info.channel ? `By: ${info.uploader ?? info.channel}` : '',
    info.duration ? `Length: ${timestamp(info.duration)}` : '',
    info.webpage_url ? `URL: ${info.webpage_url}` : '',
  ].filter(Boolean);
  if (info.chapters?.length) lines.push('Chapters:', ...info.chapters.map((c) => `- ${timestamp(c.start_time)} ${c.title}`));
  lines.push('', 'Description / caption:', info.description?.trim() ? clip(info.description.trim(), MAX_DESCRIPTION_CHARS, 'description') : '(none)');
  lines.push('', `Transcript (${captionNote}):`, transcript ? clip(transcript, MAX_TRANSCRIPT_CHARS, 'transcript') : '(none: the video has no captions, so what is said in it is not available)');
  return lines.join('\n');
}

/** A downloaded video's length, from ffmpeg's report on the file. */
async function probeSeconds(file: string): Promise<number> {
  // ffmpeg with no output exits non-zero but still prints the header.
  const out = await run(ffmpegPath!, ['-hide_banner', '-i', file], { timeout: 30_000 }).then(
    (r) => r.stderr,
    (e: { stderr?: string }) => e.stderr ?? '',
  );
  const m = out.match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0;
}

/** Speech is transcribed on the PC for videos up to this long, when they have no captions. */
const TRANSCRIBE_MAX_SECONDS = 15 * 60;

/**
 * Downloads the smallest copy that has both picture and sound, into `dir`.
 * Reels and TikToks come as one file; YouTube may need the two merged.
 */
async function download(url: string, dir: string): Promise<string | undefined> {
  await youtubedl(url, {
    ...ytdlpFlags(),
    format: 'worst[vcodec!=none][acodec!=none]/worstvideo[ext=mp4]+worstaudio/worst',
    maxFilesize: MAX_DOWNLOAD,
    noPlaylist: true,
    output: join(dir, 'video.%(ext)s'),
  });
  const video = readdirSync(dir).find((f) => f.startsWith('video.') && !f.endsWith('.part'));
  return video && join(dir, video);
}

/** Evenly spaced frames from a downloaded video. */
async function frames(file: string, duration: number, dir: string): Promise<ImagePart[]> {
  const fps = FRAME_COUNT / duration;
  await run(ffmpegPath!, ['-hide_banner', '-loglevel', 'error', '-i', file, '-vf', `fps=${fps.toFixed(4)},scale=768:-2`, '-frames:v', String(FRAME_COUNT), '-q:v', '5', join(dir, 'frame-%02d.jpg')], { timeout: 60_000 });
  return readdirSync(dir)
    .filter((f) => f.startsWith('frame-'))
    .sort()
    .map((f) => ({ type: 'image' as const, url: `frame:${f}`, mimeType: 'image/jpeg', data: readFileSync(join(dir, f)).toString('base64') }));
}

const reason = (err: unknown) => {
  const text = err instanceof Error ? ((err as Error & { stderr?: string }).stderr || err.message) : String(err);
  return text.split('\n').find((l) => l.includes('ERROR')) ?? text.split('\n')[0]!;
};

/**
 * Reads a video link: its details and transcript, plus frames when it is
 * short. With no captions, the speech is transcribed on the PC instead.
 * `language` is the spoken language's English name, for transcription.
 */
export async function readVideo(url: string, language?: string): Promise<{ content: string; images: ImagePart[] }> {
  // yt-dlp opens any page it's given; keep it off the home network.
  await assertPublic(new URL(url));
  let info: VideoInfo;
  try {
    info = (await youtubedl(url, { ...ytdlpFlags(), dumpSingleJson: true, skipDownload: true, noPlaylist: true })) as unknown as VideoInfo;
  } catch (err) {
    const why = reason(err);
    const login = /login|log in|sign in|cookies|private|rate-limit/i.test(why);
    throw new Error(`Couldn't read that video${login ? ' (the site wants a signed-in account to show it)' : ''}: ${why.replace(/^ERROR:\s*/, '')}`);
  }
  if (info._type === 'playlist') throw new Error('That link is a playlist or profile, not one video. Ask for the specific video.');

  let transcript: string | undefined;
  let captionNote = 'none available';
  const pick = pickCaptions(info);
  if (pick) {
    try {
      const res = await fetch(pick.format.url, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      transcript = captionText(await res.text(), pick.format.ext);
      captionNote = `${pick.auto ? 'automatic captions, may mishear words' : "the uploader's captions"}, ${pick.lang}`;
    } catch (err) {
      captionNote = `captions exist but couldn't be downloaded: ${reason(err)}`;
    }
  }

  // The file is fetched when there's something to take from it: frames for
  // short videos (and longer silent ones, where the screen is all there is),
  // or speech to transcribe when there are no captions. Instagram reports no
  // length, so then the file itself is measured.
  const known = info.duration ?? 0;
  const frameMax = transcript ? FRAME_MAX_SECONDS : FRAME_MAX_SECONDS_SILENT;
  const listen = !transcript && transcriptionEnabled();
  let images: ImagePart[] = [];
  const notes: string[] = [];
  if (ffmpegPath && (!known || known <= Math.max(frameMax, listen ? TRANSCRIBE_MAX_SECONDS : 0))) {
    const dir = mkdtempSync(join(tmpdir(), 'squire-video-'));
    try {
      const file = await download(url, dir);
      if (!file) throw new Error('the download came back empty');
      const duration = known || (await probeSeconds(file));
      if (listen && duration && duration <= TRANSCRIBE_MAX_SECONDS) {
        try {
          const heard = await transcribe(file, language);
          if (heard) {
            transcript = heard;
            captionNote = `transcribed from the audio on the PC${language ? ` as ${language}` : ', assuming English'}; may mishear words, especially names and amounts`;
          } else {
            captionNote = 'none: the video has no speech, only music or silence';
          }
        } catch (err) {
          captionNote = `no captions, and transcribing the audio failed: ${reason(err)}`;
        }
      }
      if (duration && duration <= frameMax) {
        images = await frames(file, duration, dir);
        if (images.length) notes.push(`${images.length} frames, evenly spaced through the video, are attached: read any on-screen text (ingredients, amounts, steps) from them.`);
      } else {
        notes.push('(No frames: the video is long, so the transcript and description are what there is.)');
      }
    } catch (err) {
      notes.push(`(The video couldn't be downloaded for frames${listen ? ' or transcription' : ''}: ${reason(err)})`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  } else if (known) {
    notes.push('(No frames: the video is long, so the transcript and description are what there is.)');
  }
  return { content: describeVideo(info, transcript, captionNote) + notes.map((n) => `\n\n${n}`).join(''), images };
}

export const VIDEO_PROMPT = `
- Video links (YouTube, Instagram reels, TikTok and the like) open with watch_video, which gives the title, creator, description or caption, a transcript (from captions, or transcribed from the audio on the PC when there are none), and a few frames from short videos. For a recipe, put it together from all of them: creators often list ingredients in the description or on screen and only say the steps. A transcript made on the PC can mishear names and amounts, so prefer what's written on screen or in the caption when they disagree. If the caption or title shows the video isn't in English, pass that language to watch_video. Say plainly what's missing (no amounts given, no speech) instead of inventing it.`;

export function videoTools(): ToolHandler[] {
  return [
    {
      def: {
        name: 'watch_video',
        description:
          'Read a video link (YouTube, Instagram, TikTok, and most other video sites): title, creator, description or caption, a transcript (from its captions, or transcribed from the audio when it has none), and 8 frames to read on-screen text from (for videos up to 4 minutes, or 15 when there are no captions).',
        strict: true,
        input_schema: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'The video link.' },
            language: {
              type: 'string',
              description:
                'The spoken language in English, lowercase ("english", "korean", "spanish"), used if the audio has to be transcribed. Use "english" unless the title or caption shows otherwise.',
            },
          },
          required: ['url', 'language'],
          additionalProperties: false,
        },
      },
      async run(args) {
        const url = findUrls(String(args.url ?? ''))[0];
        if (!url) throw new Error('That is not an http(s) link.');
        if (parseDiscordLink(url)) throw new Error('That is a Discord link; use read_discord_messages.');
        const language = String(args.language ?? '').trim().toLowerCase();
        return readVideo(url, language && language !== 'english' ? language : undefined);
      },
    },
  ];
}
