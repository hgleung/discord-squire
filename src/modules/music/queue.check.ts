/**
 * Verifies queue editing and prefetch without a voice channel. The audio player
 * runs with no subscriber (NoSubscriberBehavior.Play), so it consumes the
 * current track's stream exactly as it would when connected. Needs network.
 */
import { GuildPlayer, type Track } from './player.js';

// Real durations: a duration of 0 means a livestream, which is deliberately
// never prefetched (it would buffer without bound).
const track = (title: string, id: string): Track => ({
  title, url: `https://www.youtube.com/watch?v=${id}`, duration: 212, requestedBy: 'check',
});
// Two different videos so a prefetch of the wrong one is detectable.
const A = track('A', 'dQw4w9WgXcQ');
const B = track('B', 'gMkuV5hh7-s');
const C = track('C', 'dQw4w9WgXcQ');

let failures = 0;
const check = (label: string, ok: boolean, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${label.padEnd(46, '.')} ${ok ? 'OK' : 'FAIL'}  ${detail}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Reach the private prefetch slot; this is a check, not a public API.
type Peek = { prefetched: { track: Track; resource: { playStream: { readableLength: number } } } | null };
const peek = (p: GuildPlayer) => (p as unknown as Peek).prefetched;

const logs: string[] = [];
const player = new GuildPlayer((m) => logs.push(m));

// 1. Two tracks queued: A plays, B is prefetched.
player.enqueue([A, B]);
await sleep(300);
check('1. current is A, B prefetched', player.current === A && peek(player)?.track === B);

// 2. Give it a few seconds: B should have decoded audio waiting before its turn.
await sleep(4000);
const buffered = peek(player)?.resource.playStream.readableLength ?? 0;
check('2. next track has audio buffered ahead', buffered > 0, `${buffered} Opus frames (~${(buffered * 20 / 1000).toFixed(1)}s) decoded and waiting`);

// 3. Queue a third and move it to the front: prefetch must retarget to C.
player.enqueue([C]);
const moved = player.move(2, 'front');
await sleep(200);
check('3. move-to-front retargets prefetch', moved === C && player.queue[0] === C && peek(player)?.track === C,
  `queue is now [${player.queue.map((t) => t.title).join(', ')}]`);

// 4. Move C back to the end: prefetch returns to B.
player.move(1, 'back');
await sleep(200);
check('4. move-to-back retargets prefetch', player.queue[0] === B && peek(player)?.track === B,
  `queue is now [${player.queue.map((t) => t.title).join(', ')}]`);

// 5. Shuffle: whatever lands first is what gets prefetched.
player.shuffle();
await sleep(200);
check('5. shuffle keeps prefetch on queue[0]', peek(player)?.track === player.queue[0]);

// 6. Loop on: the current track will replay from memory, so nothing is
// prefetched -- opening a second download is exactly what YouTube 403'd.
player.setLoop(true);
await sleep(200);
check('6. loop opens no prefetch (replays from memory)', peek(player) === null);
player.setLoop(false);
await sleep(200);
check('7. loop off restores queue[0] prefetch', peek(player)?.track === player.queue[0]);

// 8. Remove queue[0]: what was second is now next, and gets prefetched.
const wasSecond = player.queue[1];
const removed = player.remove(1);
await sleep(200);
check('8. remove #1 retargets prefetch to old #2', removed !== null && player.queue[0] === wasSecond && peek(player)?.track === wasSecond,
  `removed "${removed?.title}", next is "${player.queue[0]?.title}"`);
check('9. remove out of range returns null', player.remove(99) === null);

// 10. Clear empties the queue but keeps playing; with nothing next, no prefetch.
player.enqueue([B, C]);
await sleep(200);
const before = player.queue.length;
const cleared = player.clear();
await sleep(200);
check('10. clear drops the queue, keeps current, no prefetch', cleared === before && player.queue.length === 0 && player.current === A && peek(player) === null, `dropped ${cleared}`);

// 11. Stop tears everything down; nothing left decoding in the background.
player.stop();
await sleep(300);
check('11. stop clears queue and prefetch', player.queue.length === 0 && player.current === null && peek(player) === null);

check('12. no playback errors logged', logs.length === 0, logs.join(' | '));

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
