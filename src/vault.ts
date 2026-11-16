import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

/**
 * The owner's Obsidian vault: plain markdown files on disk that Obsidian
 * syncs. Squire reads and organises the whole vault. Paths handed in and out
 * are vault-relative with forward slashes, the way Obsidian shows them.
 */
/** The bot's own folder: what only it writes, kept apart from the owner's notes. */
export const BOT_FOLDER = 'Squire';
/** Where notes saved without a folder land, for the bot to sort later. */
export const INBOX_FOLDER = `${BOT_FOLDER}/Inbox`;
/** Finished background tasks' reports. */
export const TASKS_FOLDER = `${BOT_FOLDER}/Tasks`;
/** The training plan: Training.md and the splits, kept with the owner's notes. */
export const TRAINING_FOLDER = 'Training';
/** The training log's day-by-day workout notes. */
export const WORKOUTS_FOLDER = `${BOT_FOLDER}/Workouts`;
/** The owner's recipes, at the vault root with their other notes (sorted into subfolders such as Recipes/Meal). */
export const RECIPES_FOLDER = 'Recipes';

export class Vault {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  /** Absolute path for a vault-relative one; anything that escapes the vault is refused. */
  abs(rel: string): string {
    const path = resolve(this.root, rel);
    if (path !== this.root && !path.startsWith(this.root + sep)) throw new Error(`"${rel}" is outside the vault.`);
    return path;
  }

  /**
   * A vault-relative path from what the owner or the model said:
   * "Travel/Japan" and "/Travel/Japan/" both mean Travel/Japan, and "" is the
   * vault root. Each segment is made a safe file name, which also keeps
   * Obsidian's dot-folders (.obsidian, .trash) out of reach, and ".." is refused.
   */
  notePath(input: string): string {
    const parts = input.replace(/\\/g, '/').split('/').map((p) => p.trim()).filter((p) => p && p !== '.');
    if (parts.some((p) => p === '..')) throw new Error(`"${input}" can't use "..".`);
    const rel = parts
      .map((p, i) => (i === parts.length - 1 && p.toLowerCase().endsWith('.md') ? `${noteFileName(p.slice(0, -3))}.md` : noteFileName(p)))
      .join('/');
    this.abs(rel);
    return rel;
  }

  isDir(rel: string): boolean {
    const path = this.abs(rel);
    return existsSync(path) && statSync(path).isDirectory();
  }

  /** Folders under a vault-relative folder, recursively, skipping dot-folders. */
  folders(relDir: string): string[] {
    const base = this.abs(relDir);
    if (!existsSync(base)) return [];
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.') || !entry.isDirectory()) continue;
        const path = join(dir, entry.name);
        out.push(relative(this.root, path).split(sep).join('/'));
        walk(path);
      }
    };
    walk(base);
    return out.sort();
  }

  mkdir(rel: string) {
    mkdirSync(this.abs(rel), { recursive: true });
  }

  /** Moves or renames a note or folder; refuses to overwrite. */
  move(from: string, to: string) {
    const src = this.abs(from);
    const dest = this.abs(to);
    if (!existsSync(src)) throw new Error(`Nothing at "${from}".`);
    if (existsSync(dest)) throw new Error(`"${to}" already exists.`);
    if (dest === src || dest.startsWith(src + sep)) throw new Error(`Can't move "${from}" into itself.`);
    mkdirSync(dirname(dest), { recursive: true });
    renameSync(src, dest);
  }

  read(rel: string): string | undefined {
    const path = this.abs(rel);
    return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
  }

  /**
   * Writes a note, creating folders as needed. Unchanged content is not
   * rewritten, so Obsidian Sync sees no churn. Returns whether it wrote.
   */
  write(rel: string, content: string): boolean {
    return writeIfChanged(this.abs(rel), content);
  }

  remove(rel: string) {
    rmSync(this.abs(rel), { force: true });
  }

  /** Every markdown file under a vault-relative folder, recursively, skipping dot-folders like .obsidian and .trash. */
  list(relDir = ''): string[] {
    const base = this.abs(relDir);
    if (!existsSync(base)) return [];
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith('.md')) out.push(relative(this.root, path).split(sep).join('/'));
      }
    };
    walk(base);
    return out.sort();
  }

  /** Last-modified time of a vault-relative path, or 0 when it doesn't exist. */
  mtime(rel: string): number {
    const path = this.abs(rel);
    return existsSync(path) ? statSync(path).mtimeMs : 0;
  }
}

/** Atomic write (temp file, then rename) that skips identical content. Returns whether it wrote. */
export function writeIfChanged(path: string, content: string): boolean {
  if (existsSync(path) && readFileSync(path, 'utf8') === content) return false;
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, path);
  return true;
}

/**
 * A note title made safe as an Obsidian file name: no characters Windows
 * forbids or that break [[links]] (# ^ [ ] |), no leading dots, at most 100
 * characters.
 */
export function noteFileName(title: string): string {
  const clean = title
    .replace(/[\\/:*?"<>|#^[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 100)
    .trim();
  return clean || 'Untitled';
}
