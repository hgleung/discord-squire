/** Verifies yt-dlp resolution and the audio pipeline without joining a voice channel. */
import { createAudioResource, StreamType } from '@discordjs/voice';
import youtubedl from 'youtube-dl-exec';
import ffmpegPath from 'ffmpeg-static';
import { formatDuration, resolveTracks } from './player.js';

const VIDEO = 'dQw4w9WgXcQ';
const PLAYLIST = 'PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI';
let failures = 0;
const check = (label: string, ok: boolean, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${label.padEnd(42, '.')} ${ok ? 'OK' : 'FAIL'}  ${detail}`);
};

// 1. Free-text search resolves to one YouTube track.
const search = await resolveTracks('lofi hip hop radio beats to relax', 'check');
check('1. search', search.length === 1 && search[0].url.includes('youtube'), `"${search[0]?.title}" (${formatDuration(search[0]?.duration ?? 0)})`);

// 2. Every way a specific video link gets pasted yields exactly that one video.
const forms: [string, string][] = [
  ['2a. watch link', `https://www.youtube.com/watch?v=${VIDEO}`],
  ['2b. youtu.be link', `https://youtu.be/${VIDEO}`],
  ['2c. link with timestamp', `https://www.youtube.com/watch?v=${VIDEO}&t=43s`],
  // Copying a link from inside a playlist appends &list=; the user still means this video.
  ['2d. link copied from a playlist', `https://www.youtube.com/watch?v=${VIDEO}&list=${PLAYLIST}`],
];
for (const [label, url] of forms) {
  const t = await resolveTracks(url, 'check');
  check(label, t.length === 1 && t[0].url.includes(VIDEO), `${t.length} track(s)`);
}

// 3. A bare playlist link is the one case that should expand.
const list = await resolveTracks(`https://www.youtube.com/playlist?list=${PLAYLIST}`, 'check');
check('3. bare playlist expands', list.length > 1, `${list.length} tracks`);

// 4. Audio flows yt-dlp → ffmpeg → Opus for a regular video. Read ~3s worth.
const proc = youtubedl.exec(`https://www.youtube.com/watch?v=${VIDEO}`, {
  output: '-',
  format: 'bestaudio[ext=webm]/bestaudio/best',
  noPlaylist: true,
  quiet: true,
  noWarnings: true,
  ffmpegLocation: ffmpegPath ?? undefined,
});
proc.stderr?.on('data', () => {});
const resource = createAudioResource(proc.stdout!, { inputType: StreamType.Arbitrary });
let frames = 0;
const t1 = Date.now();
await new Promise<void>((resolve) => {
  resource.playStream.on('data', () => {
    frames += 1;
    if (frames >= 150) resolve(); // 150 × 20ms frames = 3s of audio
  });
  resource.playStream.on('error', (e) => { console.log('   stream error:', e.message); resolve(); });
  setTimeout(resolve, 30_000);
});
proc.kill();
check('4. audio pipeline (regular video)', frames >= 150, `${frames} opus frames in ${Date.now() - t1}ms`);

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
