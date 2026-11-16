import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Generation, ToolCall, ToolResult } from './llm.js';

/**
 * The pages and videos the assistant and its workers actually opened and
 * read: web_fetch results, fetch_page and watch_video calls that worked.
 * Search results don't count; they are snippets, not the page.
 *
 * Recipe notes are checked against it, so a recipe can only name sources that
 * were really read. It is kept on disk for a while because a recipe is often
 * saved a message or two after it was researched ("now halve it"), or by the
 * chat after a background worker read the pages.
 */

const KEEP_DAYS = 14;
const MAX_ENTRIES = 1000;

export interface ReadEntry {
  url: string;
  title: string;
  at: string;
}

/** The same page however it is linked: no scheme, www, query, fragment or trailing slash. */
export function pageKey(url: string): string {
  try {
    const u = new URL(url.trim());
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const path = u.pathname.replace(/\/+$/, '');
    return `${host}${path}`;
  } catch {
    return url.trim().toLowerCase();
  }
}

/** Tools that read a whole page or video when they succeed, and the input holding its link. */
const READING_TOOLS = new Set(['fetch_page', 'watch_video']);

export class ReadLog {
  private entries: ReadEntry[] = [];

  /** With no path it lives in memory only (checks). */
  constructor(private readonly path?: string) {
    if (path && existsSync(path)) {
      try {
        this.entries = (JSON.parse(readFileSync(path, 'utf8')) as { pages?: ReadEntry[] }).pages ?? [];
      } catch (err) {
        console.error(`[reads] could not read ${path}; starting empty:`, err);
      }
    }
  }

  add(url: string, title = url, now = new Date()) {
    if (!/^https?:\/\//i.test(url)) return;
    const key = pageKey(url);
    this.entries = this.entries.filter((e) => pageKey(e.url) !== key);
    this.entries.push({ url, title: title.trim() || url, at: now.toISOString() });
    this.save(now);
  }

  /** The entry for a page read in the last two weeks, if any. */
  find(url: string): ReadEntry | undefined {
    const key = pageKey(url);
    return this.entries.find((e) => pageKey(e.url) === key);
  }

  /** Records the pages a model turn opened with web_fetch. */
  recordFetches(gen: Pick<Generation, 'sources'>) {
    for (const [url, title] of gen.sources.opened) this.add(url, title);
  }

  /** Records the pages and videos that fetch_page and watch_video read. */
  recordTools(calls: ToolCall[], results: ToolResult[]) {
    for (const r of results) {
      if (r.isError || !READING_TOOLS.has(r.name)) continue;
      const url = String(calls.find((c) => c.id === r.callId)?.input.url ?? '').trim();
      const title = /^Title: (.+)$/m.exec(r.content)?.[1] ?? url;
      if (url) this.add(url, title);
    }
  }

  private save(now: Date) {
    const cutoff = now.getTime() - KEEP_DAYS * 86_400_000;
    this.entries = this.entries.filter((e) => new Date(e.at).getTime() >= cutoff).slice(-MAX_ENTRIES);
    if (!this.path) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify({ pages: this.entries }, null, 2));
      renameSync(tmp, this.path);
    } catch (err) {
      console.error(`[reads] could not save ${this.path}:`, err);
    }
  }
}
