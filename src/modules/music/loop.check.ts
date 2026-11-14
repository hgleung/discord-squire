/**
 * Verifies that /loop replays from memory rather than downloading again — the
 * re-download is what YouTube was refusing with a 403. Plays an 11s video
 * through with loop on and inspects the replay. Needs network.
 */
import { GuildPlayer, type Track } from './player.js';

type Peek = { playing: { proc: unknown; captured: Buffer[] | null; capturedBytes: number; complete: boolean } | null };
const peek = (p: GuildPlayer) => (p as unknown as Peek).playing;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (label: string, ok: boolean, detail = '') => { if (!ok) failures++; console.log(`${label.padEnd(48, '.')} ${ok ? 'OK' : 'FAIL'}  ${detail}`); };

const short: Track = { title: '10 Second Timer', url: 'https://www.youtube.com/watch?v=tCDvOQI3pco', duration: 11, requestedBy: 'check' };
const logs: string[] = [];
const player = new GuildPlayer((m) => logs.push(m));

player.enqueue([short]);
player.setLoop(true);
await sleep(500);
const first = peek(player);
check('1. first play streams from yt-dlp', first?.proc !== null, 'a real process');
check('2. loop opens no prefetch stream', (player as unknown as { prefetched: unknown }).prefetched === null);

// Let the 11s track play through. The player consumes at real time.
console.log('   playing through the 11s track...');
await sleep(14_000);
const second = peek(player);
check('3. still on the same track (looped)', player.current === short);
check('4. replay came from memory, not a new yt-dlp', second !== null && second !== first && second.proc === null,
  second?.proc === null ? `${((second.capturedBytes ?? 0) / 1024).toFixed(0)} KB replayed from RAM` : 'a new process was spawned');
check('5. captured buffer was complete', first?.complete === true && (first?.captured?.length ?? 0) > 0,
  `${first?.captured?.length ?? 0} chunks, ${((first?.capturedBytes ?? 0) / 1024).toFixed(0)} KB`);

// A second loop should replay from the same buffer again.
await sleep(13_000);
const third = peek(player);
check('6. loops again from the same buffer', third !== second && third?.proc === null && third?.captured === second?.captured);

player.stop();
check('7. no playback errors', logs.length === 0, logs.join(' | '));
console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
