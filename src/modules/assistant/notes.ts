import { stringify } from 'yaml';
import type { ToolHandler } from './llm.js';
import type { ReadLog } from './readLog.js';
import { setNoteFields } from './taskNotes.js';
import { checkWritePath, factoryGuard } from './factoryGuard.js';
import { ONTOLOGY_PROMPT } from './ontology.js';
import { toLocalIso } from './time.js';
import { BOT_FOLDER, INBOX_FOLDER, noteFileName, RECIPES_FOLDER, TRAINING_FOLDER, WORKOUTS_FOLDER, type Vault } from '../../vault.js';

/**
 * The owner's Obsidian vault, for what they open themselves: task reports and
 * notes saved on request go in, and the assistant can search and read the
 * whole vault. Memory (memory.ts) stays separate; that's for the model, this
 * is for the owner.
 */

const MAX_READ_CHARS = 20_000;
const MAX_HITS = 10;
const MAX_LISTED = 200;

const frontmatter = (fields: Record<string, unknown>) => `---\n${stringify(fields).trimEnd()}\n---\n`;

/** Joins vault-relative parts, where "" is the vault root. */
const vaultJoin = (...parts: string[]) => parts.filter(Boolean).join('/');

/** How a vault-relative folder reads to the owner: "Travel/Japan/", or "the vault root". */
const shown = (folder: string) => (folder ? `${folder}/` : 'the vault root');

/**
 * Scaling a recipe is arithmetic on the source's amounts, not guesswork: the
 * assistant once "halved" a 6-serving recipe, called it serves 2, and then
 * told the owner the amounts were estimates.
 */
export const RECIPE_SCALING_PROMPT = `- A recipe note is only ever built from sources you actually opened and read: a recipe page opened with web_fetch or fetch_page, or a video read with watch_video. Search results are snippets, not recipes, and never count; neither does what you remember. For a dish asked for by name, open and read at least two full recipes from real cooking sites, take one as the base for the amounts and method, and note where the others differ. If a page won't open, try fetch_page, then another site; if you still can't read two, say so rather than filling gaps. Never invent an amount or step: mark what the sources leave out. save_note into ${RECIPES_FOLDER} needs the links you read in its sources (or "owner" for a recipe the owner typed or pasted), refuses any link that wasn't opened, and adds a Sources list to the note.
- Scaling a recipe ("cut it in half", "for 2"): find how many the source serves, then multiply every amount by the same factor (target ÷ source servings: 6 → 2 is ×⅓, 4 → 2 is ×½). If they ask for half, the note serves half the source; if they ask for a number of servings, scale to that number, not to half. Round to kitchen measures (¼ tsp, ½ cup, whole eggs). Say in the note what it was scaled from ("Serves 2, scaled ×⅓ from Yummy Tummy's 6 servings"). Scaled amounts are the source's amounts, not estimates, so don't call them that; flag only what the source itself leaves vague. Cooking times mostly stay the same.`;

export const NOTES_PROMPT = `
Obsidian notes:
- Your owner keeps notes in an Obsidian vault: recipes, checklists, project ideas, plus your past task reports (Squire/Tasks) and their training log (splits in Training, workouts in Squire/Workouts). The Squire folder holds only what you keep for yourself (Squire/Inbox, Squire/Tasks, Squire/Workouts); everything else is theirs and sits at the vault root: recipes in ${RECIPES_FOLDER} (sorted into subfolders such as ${RECIPES_FOLDER}/Meal), trips in Travel, and so on. Never put their notes under Squire, whatever an older conversation says. When they mention their notes, a list they keep, or something they wrote down, find it with search_notes and read it with read_note instead of guessing.
- The whole vault is yours to organise as they ask. Paths are from the vault root, e.g. "Travel/Japan". save_note writes a note into any folder (Squire/Inbox when they don't say where, which is yours, not theirs: file things out of it when you can), creating folders as needed; it can also append to or replace a note. list_notes shows how a folder or the whole vault is laid out, move_note moves or renames a note or a whole folder, and delete_note puts one in Obsidian's trash. When they ask for a structure ("a Travel folder with Japan under it"), build it and move the notes in; don't tell them to do it in Obsidian.
- Notes are for things they'll open themselves, so write clean markdown (headings, lists, links). Durable facts about them that help you go to memory instead, with remember.
- When you look up details (addresses, hours, prices, the real name of a place) for things in one of their notes, or things you just saved there, put them into that note in the same reply: read_note, then save_note it back with each detail next to its item, marking guesses and unconfirmed ones. Don't leave them only in chat, and don't offer to add them; say in a few words that the note is updated.
- Training and Squire/Workouts are the training log's own data: leave them to the training_ tools.
${ONTOLOGY_PROMPT}
${RECIPE_SCALING_PROMPT}`;

/** What a background worker is told about the notes it can read and write, before any recipe rules. */
export const NOTES_TASK_BASE = `
- You can read and write the owner's Obsidian notes with search_notes, list_notes, read_note and save_note. Paths are from the vault root: recipes live in ${RECIPES_FOLDER} (e.g. ${RECIPES_FOLDER}/Meal), trips in Travel. When the task says to write or replace a note, do it with save_note and say in your report which note you saved; read the existing note first if you're asked what changed. Never put the owner's notes under ${BOT_FOLDER}.`;

/** What a background worker with no job is told about notes: the base plus the recipe rules. A job's prompt note replaces the recipe rules. */
export const NOTES_TASK_PROMPT = `${NOTES_TASK_BASE}
${RECIPE_SCALING_PROMPT}`;

/** The note tools a background worker gets: no moving or deleting while nobody is watching. */
export const TASK_NOTE_TOOLS = ['save_note', 'list_notes', 'search_notes', 'read_note'];

/**
 * Checks a recipe's sources against what was actually opened and returns the
 * Sources section to add to the note. Throws, naming what's wrong, when a
 * link was never read (a search result, a guess) or no source is given.
 */
function recipeSources(reads: ReadLog, raw: unknown, content: string): string {
  const given = (Array.isArray(raw) ? raw : []).map((s) => String(s).trim()).filter(Boolean);
  const fromOwner = given.some((s) => s.toLowerCase() === 'owner');
  const links = given.filter((s) => s.toLowerCase() !== 'owner');
  if (!fromOwner && links.length === 0) {
    throw new Error(
      'A recipe needs its sources: the links of the recipe pages or videos you opened and read for it, or "owner" if the owner gave you the recipe. ' +
        "Open real recipes with web_fetch or fetch_page first; search results don't count.",
    );
  }
  const unread = links.filter((url) => !reads.find(url));
  if (unread.length) {
    throw new Error(
      `Not saved: these were never opened and read, so the recipe can't be based on them: ${unread.join(', ')}. ` +
        'Open each with web_fetch (or fetch_page if that fails) and check the recipe against what the page says, then save again. ' +
        "Search results and memory don't count.",
    );
  }
  // Every source is linked in the note, unless the content already links it.
  const lines = links
    .filter((url) => !content.includes(url))
    .map((url) => {
      const title = reads.find(url)!.title.replace(/[[\]]/g, '');
      return title && title !== url ? `- [${title}](${url})` : `- ${url}`;
    });
  if (fromOwner && !/from the owner/i.test(content)) lines.push('- From the owner');
  return lines.length ? `\n\n## Sources\n${lines.join('\n')}` : '';
}

/** A note a shadow-mode job would have written: everything checked, nothing saved. */
export interface ProposedNote {
  path: string;
  content: string;
  mode: 'create' | 'append' | 'replace';
}

export interface NotesToolOptions {
  /** Shadow mode: save_note checks the note as usual, then hands it here instead of writing it. */
  propose?: (note: ProposedNote) => void;
  /** A background task's note, as a [[link]]: every note save_note writes gets source-task pointing back to it. */
  sourceTask?: string;
  /** The owner's message this reply answers: a note in Factory/ beyond results and testing prompts changes only when it names that note. Background tasks have none. */
  ownerText?: string;
  /** A factory job's write_paths: save_note writes only under these. */
  writePaths?: string[];
  job?: string;
}

export function notesTools(vault: Vault, timeZone: string, reads?: ReadLog, options: NotesToolOptions = {}): ToolHandler[] {
  // The training log's files are read and written by code that expects them where they are.
  const guard = (rel: string) => {
    for (const folder of [TRAINING_FOLDER, WORKOUTS_FOLDER]) {
      if (rel === folder || rel.startsWith(`${folder}/`)) {
        throw new Error(`${folder} holds the training log's data; change it with the training_ tools, not as notes.`);
      }
    }
  };
  // The owner's notes stay out of the bot's folder: only the inbox takes notes
  // there (task reports are written by code). Old conversation summaries name
  // Squire/Recipes and Squire/Travel from before those folders moved to the root.
  const guardBotFolder = (rel: string) => {
    if (!rel.startsWith(`${BOT_FOLDER}/`) || rel === INBOX_FOLDER || rel.startsWith(`${INBOX_FOLDER}/`)) return;
    const rest = rel.slice(BOT_FOLDER.length + 1);
    throw new Error(`${BOT_FOLDER} only holds your own Inbox, task reports and workouts; the owner's notes go at the vault root, e.g. "${rest}" instead of "${rel}".`);
  };
  return [
    {
      def: {
        name: 'save_note',
        description:
          'Save a markdown note in the owner\'s Obsidian vault, in any folder (created if needed). "create" makes a new note and fails if the title is taken there; ' +
          '"append" adds to the end of an existing note (creating it if needed); "replace" overwrites one.',
        strict: true,
        input_schema: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'The note title; also its file name.' },
            content: { type: 'string', description: 'The note body in markdown, without a title heading.' },
            mode: { type: 'string', enum: ['create', 'append', 'replace'] },
            folder: { type: 'string', description: 'Folder from the vault root, e.g. "Travel/Japan"; empty string for Squire/Inbox.' },
            sources: {
              type: 'array',
              items: { type: 'string' },
              description: `For a recipe in ${RECIPES_FOLDER}: the links of the recipe pages and videos you opened and read for it (not search results), or "owner" if the owner typed or pasted the recipe. Empty for other notes.`,
            },
          },
          required: ['title', 'content', 'mode', 'folder', 'sources'],
          additionalProperties: false,
        },
      },
      run(args) {
        let content = String(args.content ?? '').trim();
        if (!content) throw new Error('The note is empty.');
        const folder = vault.notePath(String(args.folder ?? '').trim() || INBOX_FOLDER);
        guard(folder);
        guardBotFolder(folder);
        const rel = vaultJoin(folder, `${noteFileName(String(args.title ?? ''))}.md`);
        const existing = vault.read(rel);
        const isRecipe = folder === RECIPES_FOLDER || folder.startsWith(`${RECIPES_FOLDER}/`);
        // A new or rewritten recipe has to come from pages that were really read.
        if (reads && isRecipe && (args.mode !== 'append' || existing === undefined)) {
          content = `${content}${recipeSources(reads, args.sources, content)}`;
        }
        if (args.mode === 'create' && existing !== undefined) {
          throw new Error(`${rel} already exists. Use "append" to add to it, or pick another title.`);
        }
        let next =
          args.mode === 'append' && existing !== undefined
            ? `${existing.trimEnd()}\n\n${content}\n`
            : content.startsWith('---\n')
              ? // Content with its own frontmatter (a prompt note's job and status) keeps it, with created added.
                setNoteFields(`${content}\n`, { created: toLocalIso(new Date(), timeZone) })
              : `${frontmatter({ created: toLocalIso(new Date(), timeZone), tags: ['squire'] })}\n${content}\n`;
        // The note links back to the task that wrote it, as the task's output links to the note.
        if (options.sourceTask) next = setNoteFields(next, { 'source-task': options.sourceTask });
        factoryGuard(vault, rel, 'write', { next, ownerText: options.ownerText });
        checkWritePath(options.writePaths, options.job, rel);
        if (options.propose) {
          options.propose({ path: rel, content: next, mode: args.mode === 'append' ? 'append' : args.mode === 'replace' ? 'replace' : 'create' });
          return `Proposed ${rel} (shadow mode: not saved). It goes in your report for the owner to approve; say in the report that it's waiting for their OK.`;
        }
        vault.write(rel, next);
        return `${existing !== undefined && args.mode !== 'create' ? (args.mode === 'append' ? 'Appended to' : 'Replaced') : 'Saved'} ${rel}.`;
      },
    },
    {
      def: {
        name: 'list_notes',
        description: 'Show the folders and notes under a folder in the vault (the whole vault when empty), to see how it is organised before moving things.',
        strict: true,
        input_schema: {
          type: 'object',
          properties: { folder: { type: 'string', description: 'Folder from the vault root, e.g. "Travel"; empty string for the whole vault.' } },
          required: ['folder'],
          additionalProperties: false,
        },
      },
      run(args) {
        const folder = vault.notePath(String(args.folder ?? ''));
        if (!vault.isDir(folder)) return `No folder at ${folder}.`;
        const folders = vault.folders(folder).map((f) => `${f}/`);
        const notes = vault.list(folder);
        const all = [...folders, ...notes].sort();
        if (all.length === 0) return `${shown(folder)} is empty.`;
        const listed = all.slice(0, MAX_LISTED);
        return [shown(folder), ...listed.map((p) => `  ${p}`), all.length > listed.length ? `  …and ${all.length - listed.length} more` : '']
          .filter(Boolean)
          .join('\n');
      },
    },
    {
      def: {
        name: 'move_note',
        description:
          'Move or rename a note or a whole folder in the vault, e.g. "Squire/Inbox/Japan trip.md" to "Travel/Japan/Japan trip.md", or "Recipes" to "Food/Recipes". ' +
          'Missing folders are created; it refuses to overwrite.',
        strict: true,
        input_schema: {
          type: 'object',
          properties: {
            from: { type: 'string', description: 'The note (ending .md) or folder to move, from the vault root.' },
            to: { type: 'string', description: 'Its new path from the vault root: a note path ending .md, or a folder path.' },
          },
          required: ['from', 'to'],
          additionalProperties: false,
        },
      },
      run(args) {
        const from = vault.notePath(String(args.from ?? ''));
        let to = vault.notePath(String(args.to ?? ''));
        guard(from);
        guard(to);
        if (!from) throw new Error("The vault root can't be moved.");
        const isNote = from.endsWith('.md');
        // "Move it to Travel/Japan": a note moved onto a folder keeps its name.
        if (isNote && !to.endsWith('.md')) to = vaultJoin(to, from.split('/').at(-1)!);
        if (!isNote && to.endsWith('.md')) throw new Error('A folder needs a folder path, not a .md name.');
        guardBotFolder(to);
        factoryGuard(vault, from, 'move', { ownerText: options.ownerText });
        factoryGuard(vault, to, 'move', { ownerText: options.ownerText });
        vault.move(from, to);
        return `Moved ${from} to ${to}.`;
      },
    },
    {
      def: {
        name: 'delete_note',
        description: "Put a note or folder from the vault into Obsidian's trash (.trash in the vault), where it can be restored. Only when they ask.",
        strict: true,
        input_schema: {
          type: 'object',
          properties: { path: { type: 'string', description: 'The note (ending .md) or folder, from the vault root.' } },
          required: ['path'],
          additionalProperties: false,
        },
      },
      run(args) {
        const path = vault.notePath(String(args.path ?? ''));
        guard(path);
        if (!path) throw new Error("The vault root can't be deleted.");
        factoryGuard(vault, path, 'delete', { ownerText: options.ownerText });
        const name = path.split('/').at(-1)!;
        let dest = `.trash/${name}`;
        for (let i = 2; vault.isDir(dest) || vault.read(dest) !== undefined; i++) {
          dest = name.endsWith('.md') ? `.trash/${name.slice(0, -3)} ${i}.md` : `.trash/${name} ${i}`;
        }
        vault.move(path, dest);
        return `Moved ${path} to Obsidian's trash (${dest}).`;
      },
    },
    {
      def: {
        name: 'search_notes',
        description:
          'Search every note in the owner\'s Obsidian vault by words in the title or text. Returns matching note paths with the lines that matched. All words must appear in a note.',
        strict: true,
        input_schema: {
          type: 'object',
          properties: { query: { type: 'string', description: 'A few words, e.g. "bulgogi" or "packing list".' } },
          required: ['query'],
          additionalProperties: false,
        },
      },
      run(args) {
        const words = String(args.query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
        if (words.length === 0) throw new Error('Give at least one word to search for.');
        const hits: { path: string; score: number; lines: string[] }[] = [];
        for (const path of vault.list()) {
          const text = vault.read(path) ?? '';
          const haystack = `${path}\n${text}`.toLowerCase();
          if (!words.every((w) => haystack.includes(w))) continue;
          const lines = text.split('\n').filter((l) => words.some((w) => l.toLowerCase().includes(w)));
          // Title matches first, then by how often the words come up.
          const score = words.filter((w) => path.toLowerCase().includes(w)).length * 100 + lines.length;
          hits.push({ path, score, lines: lines.slice(0, 2).map((l) => l.trim().slice(0, 200)) });
        }
        if (hits.length === 0) return `No notes match "${args.query}".`;
        return hits
          .sort((a, b) => b.score - a.score)
          .slice(0, MAX_HITS)
          .map((h) => [h.path, ...h.lines.map((l) => `  ${l}`)].join('\n'))
          .join('\n');
      },
    },
    {
      def: {
        name: 'read_note',
        description: 'Read one note from the owner\'s Obsidian vault by its path, as returned by search_notes.',
        strict: true,
        input_schema: {
          type: 'object',
          properties: { path: { type: 'string', description: 'Vault-relative path ending in .md, e.g. "notes/cold brew.md".' } },
          required: ['path'],
          additionalProperties: false,
        },
      },
      run(args) {
        const path = String(args.path ?? '');
        if (!path.endsWith('.md')) throw new Error('Only markdown notes (.md) can be read.');
        const text = vault.read(path);
        if (text === undefined) throw new Error(`No note at "${path}". Use search_notes to find the right path.`);
        return text.length > MAX_READ_CHARS ? `${text.slice(0, MAX_READ_CHARS)}\n…(cut off; the note is ${text.length} characters)` : text;
      },
    },
  ];
}
