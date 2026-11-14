import { stringify } from 'yaml';
import type { ToolHandler } from './llm.js';
import type { Task } from './tasks.js';
import { toLocalIso } from './time.js';
import { noteFileName, type Vault } from '../../vault.js';

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

/**
 * Discord-only markdown made plain for Obsidian: "-# " subtext lines lose
 * their marker, which Obsidian would read as a list item holding a tag.
 */
const forObsidian = (text: string) => text.replace(/^-# /gm, '');

/** Saves a finished task's report under Squire/Tasks. Returns the note's path, or undefined when it couldn't be written. */
export function saveTaskReport(vault: Vault, task: Task, timeZone: string): string | undefined {
  const finished = new Date(task.finishedAt ?? Date.now());
  const rel = vault.own('Tasks', `${toLocalIso(finished, timeZone).slice(0, 10)} ${noteFileName(task.title)}.md`);
  const body =
    frontmatter({
      outcome: task.status === 'gave_up' ? "couldn't finish" : task.status,
      requested: toLocalIso(new Date(task.createdAt), timeZone),
      finished: toLocalIso(finished, timeZone),
      channel: `#${task.channelName}`,
      tags: ['squire-task'],
    }) +
    `\n# ${task.title}\n\n**Goal:** ${task.goal}\n\n**Done when:** ${task.doneWhen}\n\n## Report\n\n${forObsidian(task.result ?? '')}\n`;
  try {
    vault.write(rel, body);
    return rel;
  } catch (err) {
    console.error(`[tasks] could not save the report for ${task.id} to the vault:`, err);
    return undefined;
  }
}

export const NOTES_PROMPT = `
Obsidian notes:
- Your owner keeps notes in an Obsidian vault: recipes, checklists, project ideas, plus your past task reports (Squire/Tasks) and their workouts (Squire/Training). When they mention their notes, a list they keep, or something they wrote down, find it with search_notes and read it with read_note instead of guessing.
- The Squire folder is yours to organise as they ask. save_note writes a note into any folder under Squire (Squire/Inbox when they don't say where), creating folders as needed; it can also append to or replace a note there. list_notes shows how Squire is laid out, move_note moves or renames a note or a whole folder, and delete_note puts one in Obsidian's trash. When they ask for a structure ("a Travel folder with Japan under it"), build it and move the notes in; don't tell them to do it in Obsidian.
- Notes are for things they'll open themselves, so write clean markdown (headings, lists, links). Durable facts about them that help you go to memory instead, with remember.
- Outside Squire you can only read. Squire/Training is the training log's own data: leave it to the training_ tools.`;

export function notesTools(vault: Vault, timeZone: string): ToolHandler[] {
  // The training log's files are read and written by code that expects them where they are.
  const training = vault.own('Training');
  const guard = (rel: string) => {
    if (rel === training || rel.startsWith(`${training}/`)) {
      throw new Error(`${training} holds the training log's data; change it with the training_ tools, not as notes.`);
    }
  };
  return [
    {
      def: {
        name: 'save_note',
        description:
          'Save a markdown note in the owner\'s Obsidian vault, in a folder under Squire (created if needed). "create" makes a new note and fails if the title is taken there; ' +
          '"append" adds to the end of an existing note (creating it if needed); "replace" overwrites one.',
        strict: true,
        input_schema: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'The note title; also its file name.' },
            content: { type: 'string', description: 'The note body in markdown, without a title heading.' },
            mode: { type: 'string', enum: ['create', 'append', 'replace'] },
            folder: { type: 'string', description: 'Folder under Squire, e.g. "Travel/Japan"; empty string for Squire/Inbox.' },
          },
          required: ['title', 'content', 'mode', 'folder'],
          additionalProperties: false,
        },
      },
      run(args) {
        const content = String(args.content ?? '').trim();
        if (!content) throw new Error('The note is empty.');
        const folder = vault.ownPath(String(args.folder ?? '').trim() || 'Inbox');
        guard(folder);
        const rel = `${folder}/${noteFileName(String(args.title ?? ''))}.md`;
        const existing = vault.read(rel);
        if (args.mode === 'create' && existing !== undefined) {
          throw new Error(`${rel} already exists. Use "append" to add to it, or pick another title.`);
        }
        const next =
          args.mode === 'append' && existing !== undefined
            ? `${existing.trimEnd()}\n\n${content}\n`
            : `${frontmatter({ created: toLocalIso(new Date(), timeZone), tags: ['squire'] })}\n${content}\n`;
        vault.write(rel, next);
        return `${existing !== undefined && args.mode !== 'create' ? (args.mode === 'append' ? 'Appended to' : 'Replaced') : 'Saved'} ${rel}.`;
      },
    },
    {
      def: {
        name: 'list_notes',
        description: 'Show the folders and notes under a folder in Squire (all of Squire when empty), to see how it is organised before moving things.',
        strict: true,
        input_schema: {
          type: 'object',
          properties: { folder: { type: 'string', description: 'Folder under Squire, e.g. "Travel"; empty string for all of Squire.' } },
          required: ['folder'],
          additionalProperties: false,
        },
      },
      run(args) {
        const folder = vault.ownPath(String(args.folder ?? ''));
        if (!vault.isDir(folder)) return `No folder at ${folder}.`;
        const folders = vault.folders(folder).map((f) => `${f}/`);
        const notes = vault.list(folder);
        const all = [...folders, ...notes].sort();
        if (all.length === 0) return `${folder}/ is empty.`;
        const shown = all.slice(0, MAX_LISTED);
        return [`${folder}/`, ...shown.map((p) => `  ${p}`), all.length > shown.length ? `  …and ${all.length - shown.length} more` : '']
          .filter(Boolean)
          .join('\n');
      },
    },
    {
      def: {
        name: 'move_note',
        description:
          'Move or rename a note or a whole folder inside Squire, e.g. "Inbox/Japan trip.md" to "Travel/Japan/Japan trip.md", or "Recipes" to "Food/Recipes". ' +
          'Missing folders are created; it refuses to overwrite.',
        strict: true,
        input_schema: {
          type: 'object',
          properties: {
            from: { type: 'string', description: 'The note (ending .md) or folder to move, under Squire.' },
            to: { type: 'string', description: 'Its new path under Squire: a note path ending .md, or a folder path.' },
          },
          required: ['from', 'to'],
          additionalProperties: false,
        },
      },
      run(args) {
        const from = vault.ownPath(String(args.from ?? ''));
        let to = vault.ownPath(String(args.to ?? ''));
        guard(from);
        guard(to);
        if (from === vault.own()) throw new Error("Squire's own folder can't be moved.");
        const isNote = from.endsWith('.md');
        // "Move it to Travel/Japan": a note moved onto a folder keeps its name.
        if (isNote && !to.endsWith('.md')) to = `${to}/${from.split('/').at(-1)}`;
        if (!isNote && to.endsWith('.md')) throw new Error('A folder needs a folder path, not a .md name.');
        vault.move(from, to);
        return `Moved ${from} to ${to}.`;
      },
    },
    {
      def: {
        name: 'delete_note',
        description: "Put a note or folder under Squire into Obsidian's trash (.trash in the vault), where it can be restored. Only when they ask.",
        strict: true,
        input_schema: {
          type: 'object',
          properties: { path: { type: 'string', description: 'The note (ending .md) or folder under Squire.' } },
          required: ['path'],
          additionalProperties: false,
        },
      },
      run(args) {
        const path = vault.ownPath(String(args.path ?? ''));
        guard(path);
        if (path === vault.own()) throw new Error("Squire's own folder can't be deleted.");
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
