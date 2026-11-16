# Squire

A personal Discord bot. Runs on your own machine, in your own server, for you.

It's built as a small set of independent modules — each a directory under `src/modules` that owns some slash commands and whatever state they need. Two ship today; adding a third means adding a directory.

| Module | Commands | What it does |
|---|---|---|
| **assistant** | none needed, plus `/reminders` `/tasks` `/memories` `/usage` `/maps-todo` | A chat assistant: type in a listed channel and it answers, searches the web, sets reminders, and runs longer jobs in the background |
| **training** | `/today` `/log` `/split` `/splits` `/week` | A strength training log you can update from your phone at the gym |
| **system** | `/update` | Pulls the latest main from GitHub and restarts the bot |
| **music** | `/play` `/skip` `/queue` `/loop` `/shuffle` `/move` `/remove` `/clear` `/stop` `/music-help` | YouTube audio in a voice channel |

The training log and music are slash commands. The assistant is the one part that reads plain messages, so it needs Discord's Message Content intent, and the bot only asks for it while the assistant is switched on. It holds an outbound WebSocket to Discord — no inbound port, no tunnel, nothing hosted.

## Running it

```bash
npm install
cp .env.example .env      # then fill it in
npm start
```

`.env` needs a bot token and your Obsidian vault folder (`OBSIDIAN_VAULT`), where the training log lives. Everything else is optional. Commands are registered per-guild rather than globally, so they appear immediately in every server the bot is a member of — including one it joins later, with no restart needed.

**Only you can use it** if you set `DISCORD_ADMIN_ID` to your user ID. Anyone else gets a private refusal, and autocomplete stays empty for them so it can't leak what's in your log. Leave it blank to open the bot to the whole server.

A command can opt out of that with `public: true` — the whole music module does, so anyone in the voice channel can queue, skip, loop, or reorder. The training log stays yours.

## Assistant

List channel IDs in `ASSISTANT_CHANNEL_IDS` and add an `ANTHROPIC_API_KEY`, and anything you type in those channels gets a reply. There's no command to remember. With `DISCORD_ADMIN_ID` set, it answers only you. It also needs **Message Content Intent** switched on (Developer Portal → your app → Bot → Privileged Gateway Intents), or Discord refuses the login.

- **Memory is the channel.** Each reply reads the channel's last 30 messages (up to 12 hours back), so nothing is stored separately, a restart forgets nothing, and deleting a message removes it from what it remembers. Each channel is its own conversation, and the channel name steers the answer (#gym, #travel).
- **Web lookups** use Claude's built-in web search and fetch, and replies link their sources.
- **Reminders**: say "remind me to book the hotel Friday at 9" and it posts in that channel at that time and pings you. They can repeat (daily, weekdays, weekly, monthly) and live in `data/reminders.json`. If the PC was off when one was due, it fires late on startup and says so. `/reminders` lists them.
- **Background tasks**: bigger jobs, like "find me three hotels in Kyoto under $200 for those dates" or "watch fares to Tokyo and tell me if they drop under $800", go to a worker that keeps going after the reply and posts its report in the channel. Every task has a concrete *done when* condition and a hard deadline (at most 30 days out), and it ends at whichever comes first. A task that has to check back later saves itself to `data/tasks.json` and resumes at that time, even after a restart. Progress updates are capped, and so are API calls per task. `/tasks` lists them, and you can ask the assistant to cancel one.

Chat replies use `claude-haiku-5-5` at low effort, for speed. When the assistant starts a background task it picks a tier: research, comparison and planning go to `claude-sonnet-5-5`, and simple jobs like watching one number stay on Haiku. Tasks think at medium effort. Override the models with `ASSISTANT_MODEL` and `ASSISTANT_TASK_MODEL`. The conversation and tool format lives in `src/modules/assistant/llm.ts`. `anthropic.ts` is the only file that touches the SDK.

- **Gym talk uses the training log.** The assistant reads and writes the same log as `/today`, `/log`, `/split` and the web UI. Ask what's on today, what you lifted last push day or how your week looks, or just type "bench 185x5, 185x5, 175x6". It logs each set, loads the day's split first if needed, and points out new bests. Weekly numbers come from the app's own calculations, not the model's.
- **Memory**: the assistant keeps short facts that will make later answers better, like your gym split, preferences, people and routines. It saves them on its own, or when you say "remember…". It updates or forgets them when things change, or when you ask. Every memory goes into every reply and background task. They live in `data/memory.json` (capped at 200 short entries), and `/memories` lists them. Memory is for the assistant; notes you'll open yourself go to Obsidian.
- **Journal**: when a channel has been quiet for 30 minutes, the conversation is summarised into `data/journal.json`: what it was about, the specifics (dates, bookings, places, prices), what was decided and saved where, and what's still open. The first run reads back 10 days. Every reply sees the latest few summaries plus any plan with a date still ahead (a trip stays in view until it ends), older summaries that share words with your message ride along with it, and `recall` searches the rest. So a Tokyo restaurant reel days later lands on the Japan trip without you explaining it again.
- **Activity log**: every reply, background task, journal run and morning brief adds a line to `data/activity/<date>.jsonl`: the start of what you asked, which tools ran and which failed with what error, how long it took, the tokens it used and an estimated cost. It's the per-message half of the journal (which keeps what each conversation was about), so between them nothing is stored twice. It stays on this PC, never in the vault, and days older than 120 are deleted. `/usage` adds up spending by day, by kind and the priciest jobs, from list prices; the Anthropic console has the real bill. `npm run review:digest -- <since>` prints the journal and the activity since a time, problems first, for the daily review.
- **Voice notes**: a Discord voice message (or any audio file you attach) is transcribed on this PC with the same Whisper model used for reels, and the transcript stands in for the message from then on, in later replies and in the journal too. Transcripts are kept in `data/voice.json`. Notes over 10 minutes are skipped.
- **Morning brief**: at 8 AM (`MORNING_BRIEF_HOUR`), #misc gets one message (or `MORNING_BRIEF_CHANNEL_ID`; #misc is found by name once and then kept by ID, so renaming it is fine) with today's weather at home, your calendar and reminders for today, anything in the last day's mail that needs you (Gmail's promotions and social tabs left out), what the journal says is still open, any background tasks running, and how many spots are waiting to be saved in Maps. The facts are gathered by the bot; the chat model only words them. A PC switched on later in the morning still gets it, until 1 PM.
- **Obsidian notes**: "save this recipe to my notes" writes a note to `Squire/Inbox/` in your vault, or to any folder you name. It organises the whole vault as you ask: makes folders and subfolders, moves and renames notes and folders, and puts notes in Obsidian's trash. It can also search and read any note ("what's on my packing list?"), and never touches Obsidian's own dot-folders. Its own files live in `Squire/`: the inbox is its own scratch space, it leaves `Training/` and `Squire/Workouts/` to the training log, and every finished background task saves its report to `Squire/Tasks/<date> <title>.md`, and the Discord message says where.
- **Gmail and Calendar** (optional): search and read mail, save drafts (it never sends), and read, create, change and delete calendar events. Setup is a Google Cloud OAuth client (Desktop app) with the Gmail and Calendar APIs enabled, then `npm run google:auth` once. `.env.example` has the steps. More Gmail accounts can be added for mail (`GOOGLE_EXTRA_ACCOUNTS=work`, then `npm run google:auth -- work`): searches cover every account unless one is named, and the morning brief checks each inbox with the same filter. Background tasks get read-only access. Email and invite text comes from strangers, so the assistant is told to treat it as information and never as instructions. Even so, a hostile email can try to steer it. That's why it can't send, and why unattended tasks can't write anything.
- **Saved places** (optional): your Google Maps lists (Food, Bars, Dessert, Cafes) back "dessert near Mission Dolores", "a cafe open now to work from" and "what's good in Chicago". Google has no API for saved lists. Each list is read from its share link (`MAPS_LIST_URLS`) through the unofficial endpoint the list's own web page uses, every 6 hours, into `data/places.json`. A failed read keeps the last good copy, and `places_lists` shows the error. With `GOOGLE_MAPS_API_KEY` (Places API (New)), each spot gets its hours, rating and price, looked up once and refreshed monthly. That makes "open now", "near <anywhere>" and adding spots by chat ("save Tartine to dessert") possible. Spots added by chat go into the existing list that fits (a new list only if you ask for one by name) and live in Squire's copy only, since Maps can't be written to; the reply carries the Maps link so saving it there is one tap. `/maps-todo` lists every spot still waiting to be saved in Maps, with its link, and each drops off on its own once the next sync finds it in the Maps list. When a calendar event today is more than 80 km from home (an all-day "Stay at a hotel in Chicago", say), the first assistant channel gets one morning message with your saved spots there.

`ASSISTANT_LOCATION` sets your default location. Searches are localised to it, and "the weather" means there unless you say otherwise. `ASSISTANT_ABOUT_ME` is a line of anything else it should always know about you. Both live in `.env`, so they stay off GitHub. `npm run check:assistant:live` makes one real round trip, a web question plus a reminder, without Discord.

## Training log

Log what you trained: the exercises, and for each set the weight, reps, and whether you hit it.

- **Splits, not schedules.** `/split Push day` loads that session's exercises. Nothing is tied to a clock — an exercise is a list of sets.
- **Weights carry forward.** Loading a split pre-fills each exercise with what you lifted last time, left unticked so you confirm each set.
- **`/log bench 140 6`** fills the next unticked set. Extra sets beyond the plan are appended, not refused. It tells you when a set is a new best.
- **The headline metric is hard sets per muscle group per week**, which is the variable you actually program against and the one a PPL split hides — "all sets done" while your rear delts got four and your triceps got twenty-eight. Load progression is tracked per lift via estimated 1RM, so a heavy triple and a set of ten are comparable.
- **The log is markdown in your Obsidian vault**, and those files are the source of truth. Each split is a note in `Training/Splits/` and `Training/Training.md` holds the plan name, unit and quick-add exercises, both next to your own notes. Each workout is its own note in `Squire/Workouts/` (`2026-11-12 Workout.md`). A set is a checkbox line (`- [x] 185 lb × 5`; `—` marks a weight or reps not yet entered), so ticking it in Obsidian logs it. Under each exercise heading, one line carries the target, muscles and colour (`Target: 4 × 6 · Primary: Chest · Secondary: Triceps · Color: red`). Any other line is that exercise's note. A heading you add by hand becomes an exercise. Edits you make in Obsidian show up in Discord and the web UI within a second or so. Text outside those shapes, like a paragraph above the first exercise, is dropped the next time the bot writes that note. A file that won't parse is skipped with a warning and never deleted.

`/week` writes a summary of the week — days trained, which muscles landed in or under their target range, which lifts moved. It runs through a **local model via [Ollama](https://ollama.com)**, so nothing leaves your machine:

```bash
ollama pull qwen2.5:7b
```

The numbers in that summary are computed by the app, not the model. Asked to restate them, a 3B model reported a +10.8% squat PR as "held" in three runs out of three; the model gets the prose, the figures are rendered directly. `qwen2.5:7b` is the tested recommendation — it quoted set counts and target ranges correctly where `llama3.2` carried one muscle's figures onto another's line every run.

### Optional web UI

`web/` holds a browser UI for the same log: a muscle-volume chart, per-lift progression, and a split editor. It's off by default.

```bash
# .env
WEB_PORT=4000
```

```bash
npm run web          # dev server on :5173, proxies /api to the bot
npm run web:build    # after which the bot serves it at :4000 directly
```

The bot owns the log; the UI is a client of it. Every write carries the revision it was based on, so a set logged from Discord can't be overwritten by a browser tab that was open at the time — the tab adopts the newer copy instead. Server-sent events push changes the other way, so a set logged from your phone, or ticked in Obsidian, appears in an open tab without a refresh. The UI's "Save as file" still downloads the whole log as JSON, which works as a backup, and `npm run training:import -- <file.json> "<vault>/Training"` turns such a file back into notes in an empty folder (workouts land in its `Workouts/`).

## Music

`/play` takes a link or search text, joins your voice channel, and plays. Playlist links queue up to 50; a video link copied from inside a playlist plays just that video. `/shuffle` reorders what's queued, `/move` sends a track to play next or last, `/remove` drops one — both by its number in `/queue` — and `/clear` empties it while the current track keeps playing. It leaves on its own after two idle minutes. `/music-help` lists every music command with its arguments, generated from the commands themselves so it can't drift out of sync.

Tracks run into each other without a gap. Opening a stream costs a second or two — yt-dlp's signature solve, then ffmpeg probing the container — so the next track is opened while the current one plays and sits back-pressured with about a second of audio already decoded. Reordering the queue retargets it; the check confirms that for move, shuffle, and remove.

`/loop` never downloads twice. The bytes are kept in memory as a track plays, and a loop replays them — YouTube refused a rapid re-download of a track that had just played through with a 403, and a second fetch is wasted work regardless. Live streams are the exception: they never end, so they're neither buffered nor prefetched.

**Age-restricted videos** are skipped with "Sign in to confirm your age" unless yt-dlp has a YouTube login. `YOUTUBE_COOKIES` (a cookies.txt exported from a signed-in browser) or `YOUTUBE_COOKIES_FROM_BROWSER=chrome` in `.env` provides one. yt-dlp then acts as that account, so a throwaway is the sensible choice.

Audio comes through [yt-dlp](https://github.com/yt-dlp/yt-dlp) and a bundled ffmpeg, so nothing needs installing beyond `npm install`. YouTube requires solving a JavaScript challenge to get valid media URLs; yt-dlp is pointed at the Node the bot runs on for that, without which every video resolves and then plays silence.

**Two things to know.** Streaming YouTube this way is against YouTube's terms of service; the bot this was ported from ([maxcutlyp/YoutubeBot](https://github.com/maxcutlyp/YoutubeBot)) exists because the big hosted music bots were taken down for exactly this. Self-hosting privately is the lowest-risk form of the same activity, not a different one. And yt-dlp is in a permanent cat-and-mouse with YouTube — when playback breaks with no code change, `npm update youtube-dl-exec` is the first thing to try.

## Updating

`/update` (owner-only) fetches main from GitHub, fast-forwards the checkout the bot runs from, runs `npm install` if the lockfile changed, and exits so the Windows launcher starts it again on the new code. It refuses, and changes nothing, when the checkout is on another branch or has local changes. `.gitattributes` keeps Windows line endings from counting as local changes.

## Adding a module

A module is a directory under `src/modules` exporting a `BotModule`: a name and a list of `Command`s, each pairing a `SlashCommandBuilder` with a `run` function. Throw from `run` to fail — the dispatcher turns it into a reply. Register it in `src/index.ts`.

```
src/
  index.ts           entry: config → vault → modules → bot → optional web API
  bot.ts             client, command registry, owner gate, dispatch
  config.ts          typed .env
  vault.ts           the Obsidian vault: safe paths, unchanged-skipping writes
  modules/
    types.ts         the BotModule and Command contracts
    assistant/       chat agent, background tasks, memory, notes, Gmail/Calendar;
                     llm.ts is the conversation/tool core, anthropic.ts the API adapter
    training/        log commands, the markdown plan store, the web API
    music/           player, yt-dlp resolution
    system/          /update
lib/                 domain logic shared by the bot and the web UI
web/                 the optional React UI
```

`lib/` is deliberately neutral — scoring, e1RM, plan validation, and the summary prompt live there so the bot and the web UI cannot drift apart. It is plain TypeScript with no Node or browser APIs.

## Checking it works

```bash
npm run typecheck
npm run check        # training smoke, music pipeline, queue/prefetch, loop-from-memory
```

The training smoke test exercises the markdown store (round trips, a checkbox ticked on disk, a hand-added exercise, a renamed split) and every command's logic against a temporary folder. The assistant check covers the conversation as the Messages API receives it, background tasks against a scripted model, memory, notes, and the Gmail message building and parsing. The music check resolves a search and each way a video link gets pasted, then decodes three seconds of audio through the full pipeline. Together they cover everything short of the Discord connection and the live APIs. `npm run check:assistant:live` makes one real round trip to Claude.

Built with discord.js, @discordjs/voice, yt-dlp, and Express. The web UI is React, Vite, and Tailwind.
