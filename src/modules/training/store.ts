import { existsSync, readdirSync, readFileSync, rmSync, statSync, watch, type FSWatcher } from 'node:fs';
import { EventEmitter } from 'node:events';
import { join, resolve } from 'node:path';
import type { PlanData } from '../../../lib/types.js';
import { parsePlanData } from '../../../lib/planFile.js';
import { writeIfChanged } from '../../vault.js';
import { SPLITS, TRAINING_NOTE, WORKOUTS, isOwnedFile, parsePlan, renderPlan } from './markdown.js';

export class RevisionConflictError extends Error {
  constructor(
    readonly expected: number,
    readonly actual: number,
  ) {
    super(`Plan changed since you loaded it (expected revision ${expected}, now ${actual}).`);
  }
}

/**
 * The single owner of the training folder in the vault. Every writer — the web
 * app over HTTP, the Discord bot in-process — goes through here, so there is
 * one place that decides who wins a conflict. The owner editing in Obsidian is
 * the other writer, and their edits are picked up as new revisions.
 *
 * `rev` increments on each accepted write or outside edit. A client that read
 * at rev N must present N to write; anything else means someone changed the
 * plan underneath it and the write is refused rather than silently clobbering.
 */
export class PlanStore extends EventEmitter {
  private readonly dir: string;
  private cached: PlanData | null = null;
  private revision = 0;
  /** (path, mtime, size) of every file last read or written; a mismatch means an outside edit. */
  private signature = '';
  /** Files that didn't parse. They're missing from the plan, so they must not be deleted for being absent from it. */
  private unreadable = new Set<string>();
  private watcher: FSWatcher | undefined;
  private watchFailed = false;
  private debounce: NodeJS.Timeout | undefined;

  constructor(dir: string) {
    super();
    this.dir = resolve(dir);
    this.watch();
  }

  /** The training folder. */
  get file(): string {
    return this.dir;
  }

  get rev(): number {
    this.refreshIfChangedOnDisk();
    return this.revision;
  }

  exists(): boolean {
    return existsSync(join(this.dir, TRAINING_NOTE));
  }

  load(): PlanData {
    if (!this.exists()) {
      throw new Error(`No training log at ${this.dir} (no ${TRAINING_NOTE}). Open the web app, or use a training command, to create one.`);
    }
    this.refreshIfChangedOnDisk();
    return this.cached!;
  }

  /** Creates the log if absent — the web app's first-run setup lands here. */
  init(plan: PlanData): number {
    return this.writeThrough(plan);
  }

  /**
   * @param expectedRev when given, the write is refused unless it matches the
   * current revision. Omit only for writers that cannot have a stale read.
   */
  save(plan: PlanData, expectedRev?: number): number {
    if (expectedRev !== undefined) {
      const current = this.rev;
      if (expectedRev !== current) throw new RevisionConflictError(expectedRev, current);
    }
    return this.writeThrough(plan);
  }

  /** Read-modify-write; used by the Discord bot. Returns the plan as stored. */
  update(fn: (plan: PlanData) => PlanData): PlanData {
    this.writeThrough(fn(this.load()));
    return this.cached!;
  }

  /** Training.md plus the top level of Workouts/ and Splits/, folder-relative. */
  private files(): string[] {
    const out = existsSync(join(this.dir, TRAINING_NOTE)) ? [TRAINING_NOTE] : [];
    for (const folder of [WORKOUTS, SPLITS]) {
      if (!existsSync(join(this.dir, folder))) continue;
      for (const entry of readdirSync(join(this.dir, folder), { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith('.md')) out.push(`${folder}/${entry.name}`);
      }
    }
    return out.sort();
  }

  private signatureOf(files: string[]): string {
    return files
      .map((rel) => {
        const stat = statSync(join(this.dir, rel), { throwIfNoEntry: false });
        return `${rel}|${stat?.mtimeMs}|${stat?.size}`;
      })
      .join('\n');
  }

  /**
   * Picks up edits made by anything other than this process — Obsidian, sync,
   * a restored backup — and treats them as a new revision.
   */
  private refreshIfChangedOnDisk(): void {
    if (!this.exists()) return;
    this.watch();
    const files = this.files();
    const signature = this.signatureOf(files);
    if (this.cached !== null && signature === this.signature) return;

    const contents = new Map<string, string>();
    for (const rel of files) {
      // Obsidian renames by delete-and-create, so a listed file can vanish before it's read.
      try {
        contents.set(rel, readFileSync(join(this.dir, rel), 'utf8'));
      } catch {}
    }
    const { plan, failed } = parsePlan(contents, (m) => console.warn(`[training] ${m}`));
    const outsideEdit = this.cached !== null;
    this.cached = plan;
    this.unreadable = new Set(failed);
    this.signature = signature;
    this.revision += 1;
    if (outsideEdit) this.emit('change', this.revision);
  }

  private writeThrough(plan: PlanData): number {
    // Validate exactly what lib accepts from a plan file. Without this the
    // server would render whatever a client sends and only discover it is
    // unreadable on the next load, by which point the real log is gone.
    const files = renderPlan(parsePlanData(JSON.stringify(plan)));

    for (const [rel, content] of files) writeIfChanged(join(this.dir, rel), content);
    // Case-insensitive so a split renamed only in case isn't deleted after being written (Windows ignores case).
    const keep = new Set([...files.keys()].map((rel) => rel.toLowerCase()));
    for (const rel of this.files()) {
      if (isOwnedFile(rel) && !keep.has(rel.toLowerCase()) && !this.unreadable.has(rel)) rmSync(join(this.dir, rel), { force: true });
    }

    // Cache what a fresh load would see, ids included, so the cache always equals the disk.
    this.cached = parsePlan(files).plan;
    for (const rel of files.keys()) this.unreadable.delete(rel);
    this.signature = this.signatureOf(this.files());
    this.revision += 1;
    this.watch();
    this.emit('change', this.revision);
    return this.revision;
  }

  /**
   * Stops watching the folder. Needed before deleting it: on Windows a watcher
   * on a removed folder keeps the process alive, unref() or not.
   */
  close(): void {
    clearTimeout(this.debounce);
    this.watcher?.close();
    this.watcher = undefined;
    this.watchFailed = true;
  }

  /**
   * Notices Obsidian edits as they happen so an open web app updates live,
   * not just on its next request. Started lazily because fs.watch needs the
   * folder to exist. Our own writes come through here too, and are ignored
   * because the signature already matches them.
   */
  private watch(): void {
    if (this.watcher || this.watchFailed || !existsSync(this.dir)) return;
    try {
      this.watcher = watch(this.dir, { recursive: true }, (_event, name) => {
        if (name?.endsWith('.tmp')) return;
        // Saves arrive as bursts of events; settle before re-reading.
        clearTimeout(this.debounce);
        this.debounce = setTimeout(() => {
          try {
            this.refreshIfChangedOnDisk();
          } catch (err) {
            console.warn('[training] Re-reading the training folder failed:', err);
          }
        }, 300);
        this.debounce.unref();
      });
      this.watcher.on('error', (err) => {
        // Typically the folder was deleted or moved; the next access starts a new watcher.
        console.warn('[training] Watching the training folder failed:', err.message);
        this.watcher?.close();
        this.watcher = undefined;
      });
      this.watcher.unref();
    } catch (err) {
      // Without the watcher, outside edits still show up on the next request.
      this.watchFailed = true;
      console.warn('[training] Not watching the training folder for edits:', err instanceof Error ? err.message : err);
    }
  }
}
