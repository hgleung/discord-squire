import {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
  type AudioPlayer,
  type AudioResource,
  type VoiceConnection,
} from '@discordjs/voice';
import { escapeMarkdown as md } from 'discord.js';
import type { VoiceBasedChannel } from 'discord.js';
import { Readable } from 'node:stream';
import youtubedl from 'youtube-dl-exec';
import ffmpegPath from 'ffmpeg-static';

export interface Track {
  title: string;
  url: string;
  /** Seconds; 0 when unknown (live streams). */
  duration: number;
  requestedBy: string;
}

/**
 * YouTube now requires solving a JavaScript signature challenge to get valid
 * media URLs. yt-dlp only enables deno for that by default and silently falls
 * back to unsolved URLs otherwise, which fetch a 403 -- so the track resolves
 * with a title and duration and then plays nothing. The server is already
 * Node, so hand yt-dlp the exact binary it is running under.
 */
const YTDLP_COMMON = {
  noWarnings: true,
  jsRuntimes: `node:${process.execPath}` as `node:${string}`,
  ffmpegLocation: ffmpegPath ?? undefined,
};

export interface YtdlpAuth {
  /** Path to a Netscape-format cookies.txt exported from a logged-in browser. */
  cookies?: string;
  /** Browser to read YouTube cookies from directly, e.g. "chrome" or "firefox". */
  cookiesFromBrowser?: string;
}

/**
 * Age-restricted videos need a signed-in session; without one yt-dlp reports
 * "Sign in to confirm your age" and the track is skipped. Either option lends
 * yt-dlp a YouTube login for the whole process.
 */
let authFlags: { cookies?: string; cookiesFromBrowser?: string } = {};
export function configureYtdlp(auth: YtdlpAuth): void {
  authFlags = {};
  if (auth.cookies) authFlags.cookies = auth.cookies;
  else if (auth.cookiesFromBrowser) authFlags.cookiesFromBrowser = auth.cookiesFromBrowser;
}
export const ytdlpFlags = () => ({ ...YTDLP_COMMON, ...authFlags });

/** Leave the channel after this long with nothing to play. */
const IDLE_DISCONNECT_MS = 2 * 60 * 1000;
/** Cap on tracks pulled from a single playlist link. */
const PLAYLIST_LIMIT = 50;

/** Shape of yt-dlp's --dump-single-json output, reduced to what we read. */
interface YtEntry {
  id?: string;
  title?: string;
  webpage_url?: string;
  url?: string;
  duration?: number;
  entries?: YtEntry[];
}

/**
 * Turns a URL or free-text query into one or more tracks. Search goes through
 * yt-dlp's own `ytsearch:` so there is no separate search dependency to break
 * when YouTube changes something.
 */
export async function resolveTracks(query: string, requestedBy: string): Promise<Track[]> {
  const trimmed = query.trim();
  const isUrl = /^https?:\/\//i.test(trimmed);
  const target = isUrl ? trimmed : `ytsearch1:${trimmed}`;

  // A link that names a video is a request for that video, even when it also
  // carries a &list= — which is what copying from inside a playlist produces.
  // Left alone, yt-dlp expands the playlist and the linked video may not even
  // be first. Only a bare /playlist URL should queue the whole list.
  const namesAVideo = isUrl && (/[?&]v=/.test(trimmed) || /youtu\.be\//i.test(trimmed));

  const info = (await youtubedl(target, {
    ...ytdlpFlags(),
    dumpSingleJson: true,
    flatPlaylist: true,
    playlistEnd: PLAYLIST_LIMIT,
    // A false boolean is rendered as --no-no-playlist, which yt-dlp rejects;
    // the flag can only be present or absent.
    ...(namesAVideo ? { noPlaylist: true } : {}),
  })) as unknown as YtEntry;

  const entries = info.entries?.length ? info.entries : [info];
  return entries
    .filter((e) => e.title && (e.webpage_url || e.url || e.id))
    .map((e) => ({
      title: e.title!,
      url: e.webpage_url ?? e.url ?? `https://www.youtube.com/watch?v=${e.id}`,
      duration: Math.round(e.duration ?? 0),
      requestedBy,
    }));
}

export function formatDuration(seconds: number): string {
  if (!seconds) return 'live';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m >= 60
    ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

/** Don't hold more than this of one track in memory for replay. */
const REPLAY_CAP_BYTES = 64 * 1024 * 1024;

/** A yt-dlp process and the Opus resource being decoded from it. */
interface OpenStream {
  track: Track;
  proc: ReturnType<typeof youtubedl.exec> | null;
  resource: AudioResource;
  /** Populated from stderr so a failure can say why. */
  stderr: string;
  /**
   * The raw audio bytes as they came off yt-dlp, kept so /loop can replay the
   * track from memory instead of downloading it again. YouTube refuses some
   * rapid re-downloads with a 403 -- a re-request of a track that had just
   * played through fine -- and a second fetch is wasted work regardless.
   * null once the cap is exceeded or for live streams.
   */
  captured: Buffer[] | null;
  capturedBytes: number;
  /** yt-dlp exited cleanly, so `captured` holds the whole track. */
  complete: boolean;
}

export class GuildPlayer {
  readonly queue: Track[] = [];
  current: Track | null = null;
  loop = false;
  /** Set by the command that started playback; posts to that text channel. */
  notify: ((message: string) => Promise<unknown>) | null = null;

  private readonly player: AudioPlayer;
  private connection: VoiceConnection | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private playing: OpenStream | null = null;
  /**
   * The track after the current one, already resolved through yt-dlp and
   * ffmpeg while the current one plays. Starting a stream costs a second or
   * two of signature-solving and probing; doing it ahead of time is what
   * makes one track run into the next without a gap.
   */
  private prefetched: OpenStream | null = null;

  constructor(private readonly onLog: (msg: string) => void) {
    // Keep playing even if nobody is listening: pausing on an empty channel
    // would stall the queue and the idle timer handles leaving anyway.
    this.player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });

    this.player.on(AudioPlayerStatus.Idle, () => {
      if (this.loop && this.current) this.queue.unshift(this.current);
      this.current = null;
      void this.playNext();
    });

    // An unhandled 'error' on the player would take the process down, HTTP
    // server included. Log it and move on to the next track instead.
    this.player.on('error', (err) => {
      const title = this.current?.title ?? '?';
      this.onLog(`playback error on "${title}": ${err.message}`);
      void this.notify?.(`⚠️ Playback failed on **${md(title)}** — ${err.message}. Skipping.`);
      this.current = null;
      void this.playNext();
    });
  }

  get connected(): boolean {
    return this.connection !== null && this.connection.state.status !== VoiceConnectionStatus.Destroyed;
  }

  async join(channel: VoiceBasedChannel): Promise<void> {
    if (this.connected && this.connection!.joinConfig.channelId === channel.id) return;
    this.connection?.destroy();

    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: true,
    });
    this.connection = connection;

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      // A brief disconnect (channel move, network blip) usually recovers;
      // only give up if it doesn't settle within a few seconds.
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        this.leave();
      }
    });
    connection.on('error', (err) => this.onLog(`voice connection error: ${err.message}`));

    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    connection.subscribe(this.player);
  }

  // ---- queue edits ------------------------------------------------------
  // Every edit ends with prefetch(): whichever track is now next may not be
  // the one already being decoded.

  enqueue(tracks: Track[]): void {
    this.queue.push(...tracks);
    this.clearIdle();
    if (!this.current) void this.playNext();
    else this.prefetch();
  }

  /** Fisher-Yates over the pending queue; the current track keeps playing. */
  shuffle(): number {
    for (let i = this.queue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.queue[i], this.queue[j]] = [this.queue[j], this.queue[i]];
    }
    this.prefetch();
    return this.queue.length;
  }

  /** Moves the 1-based queue position to play next or last. Returns the track, or null if out of range. */
  move(position: number, to: 'front' | 'back'): Track | null {
    const idx = position - 1;
    if (idx < 0 || idx >= this.queue.length) return null;
    const [track] = this.queue.splice(idx, 1);
    if (to === 'front') this.queue.unshift(track);
    else this.queue.push(track);
    this.prefetch();
    return track;
  }

  /** Removes the 1-based queue position. Returns the track, or null if out of range. */
  remove(position: number): Track | null {
    const idx = position - 1;
    if (idx < 0 || idx >= this.queue.length) return null;
    const [track] = this.queue.splice(idx, 1);
    this.prefetch(); // removing #1 changes what's next
    return track;
  }

  /** Empties the pending queue; the current track keeps playing. Returns how many were dropped. */
  clear(): number {
    const n = this.queue.length;
    this.queue.length = 0;
    this.prefetch(); // nothing is next now, so this discards the prefetch (unless looping)
    return n;
  }

  /** Skips `count` tracks including the current one; returns how many were dropped. */
  skip(count: number): number {
    const fromQueue = Math.max(0, Math.min(count - 1, this.queue.length));
    this.queue.splice(0, fromQueue);
    const skippedCurrent = this.current !== null;
    this.loop = false; // skipping while looping would just replay the same track
    this.player.stop(true); // triggers Idle -> playNext
    return fromQueue + (skippedCurrent ? 1 : 0);
  }

  setLoop(on: boolean): void {
    this.loop = on;
    this.prefetch(); // "next" is now the current track, or no longer is
  }

  stop(): void {
    this.queue.length = 0;
    this.loop = false;
    this.current = null;
    this.discardPrefetch();
    this.player.stop(true);
    this.leave();
  }

  // ---- playback ---------------------------------------------------------

  private async playNext(): Promise<void> {
    const finished = this.playing;
    this.closeStream(finished);
    this.playing = null;

    const next = this.queue.shift();
    if (!next) {
      this.scheduleIdle();
      return;
    }
    this.current = next;

    let stream: OpenStream;
    if (finished?.track === next && finished.complete && finished.captured) {
      // Looping: the whole track is in memory from the play that just ended.
      stream = this.replayStream(finished);
    } else if (this.prefetched?.track === next && !this.prefetched.resource.ended) {
      // Use the prefetched stream if it is for this exact track and still alive.
      stream = this.prefetched;
      this.prefetched = null;
    } else {
      // The prefetch was for a track that got reordered away, or failed while
      // waiting, or this is a loop of a track that never finished downloading.
      this.discardPrefetch();
      stream = this.openStream(next);
    }
    this.playing = stream;
    this.player.play(stream.resource);

    this.prefetch();
  }

  /** A stream fed from captured bytes; the buffer is kept so it can loop again. */
  private replayStream(from: OpenStream): OpenStream {
    const chunks = from.captured!;
    return {
      track: from.track,
      proc: null,
      resource: createAudioResource(Readable.from(chunks), { inputType: StreamType.Arbitrary }),
      stderr: '',
      captured: chunks,
      capturedBytes: from.capturedBytes,
      complete: true,
    };
  }

  private prefetch(): void {
    // Loop replays the current track from the bytes already captured, so
    // there is nothing to fetch ahead. Live streams can't be prefetched
    // either: they never end, so the buffer would grow without bound.
    const target = this.loop ? null : this.queue[0];
    if (!target || target.duration === 0) return this.discardPrefetch();
    if (this.prefetched?.track === target) return;
    this.discardPrefetch();
    this.prefetched = this.openStream(target);
  }

  private openStream(track: Track): OpenStream {
    // yt-dlp writes the best audio-only format to stdout; @discordjs/voice runs
    // ffmpeg on the far end (StreamType.Arbitrary) to turn it into Opus. The
    // pipe fills to its high-water mark and then back-pressures, so a stream
    // opened ahead of time sits paused rather than buffering the whole track.
    const proc = youtubedl.exec(track.url, {
      ...ytdlpFlags(),
      output: '-',
      format: 'bestaudio[ext=webm]/bestaudio/best',
      noPlaylist: true,
      quiet: true,
    });

    const stream: OpenStream = {
      track,
      proc,
      resource: createAudioResource(proc.stdout!, { inputType: StreamType.Arbitrary }),
      stderr: '',
      captured: track.duration > 0 ? [] : null,
      capturedBytes: 0,
      complete: false,
    };
    proc.stderr?.on('data', (chunk: Buffer) => (stream.stderr += chunk.toString()));

    // Tee the bytes into memory as they flow to ffmpeg. This listener respects
    // the pipe's back-pressure, so it fills at playback pace and holds nothing
    // the player hasn't already received.
    proc.stdout?.on('data', (chunk: Buffer) => {
      if (!stream.captured) return;
      stream.capturedBytes += chunk.length;
      if (stream.capturedBytes > REPLAY_CAP_BYTES) {
        stream.captured = null; // too big to hold; loop will re-download
        return;
      }
      stream.captured.push(chunk);
    });
    proc.on('exit', (code) => {
      if (code === 0) stream.complete = true;
    });

    // The child is also a promise that rejects on non-zero exit. Left uncaught
    // it surfaces as an unhandled rejection with no word to the person who
    // pressed play; caught, it becomes a message and a skip.
    proc.catch(() => {
      if (this.playing === stream && this.current === track) {
        const reason = stream.stderr.match(/ERROR:\s*(.+)/)?.[1]?.trim() ?? 'yt-dlp exited with an error';
        this.onLog(`could not play "${track.title}": ${reason}`);
        void this.notify?.(`⚠️ Couldn't play **${md(track.title)}** — ${reason}. Skipping.`);
        this.current = null;
        void this.playNext();
      } else if (this.prefetched === stream) {
        // Failed while waiting in the wings. Drop it; playNext will retry
        // from scratch when its turn comes, and report loudly if it fails again.
        this.prefetched = null;
      }
    });

    return stream;
  }

  private closeStream(stream: OpenStream | null): void {
    if (!stream) return;
    stream.proc?.kill();
    if (!stream.resource.ended) stream.resource.playStream.destroy();
  }

  private discardPrefetch(): void {
    this.closeStream(this.prefetched);
    this.prefetched = null;
  }

  private scheduleIdle(): void {
    this.clearIdle();
    this.idleTimer = setTimeout(() => this.leave(), IDLE_DISCONNECT_MS);
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private leave(): void {
    this.clearIdle();
    this.closeStream(this.playing);
    this.playing = null;
    this.discardPrefetch();
    this.connection?.destroy();
    this.connection = null;
  }
}
