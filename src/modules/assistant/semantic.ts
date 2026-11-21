import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ToolHandler } from './llm.js';
import type { Vault } from '../../vault.js';
import { TRAINING_FOLDER, WORKOUTS_FOLDER } from '../../vault.js';
import type { Journal, JournalEntry } from './journal.js';

/**
 * Search by meaning over the vault and the journal, with embeddings from a
 * local Ollama model, so nothing leaves the machine. "That place Chris
 * recommended" finds the conversation even when it never used those words.
 *
 * Each note is cut into chunks; each chunk and each journal entry is embedded
 * once and kept in data/semantic.json with a hash of its text, so a refresh
 * only embeds what changed. When Ollama isn't running, search says so and the
 * keyword tools (search_notes, recall) still work.
 */

export type Embed = (texts: string[], kind: 'document' | 'query') => Promise<number[][]>;

/**
 * Embeddings from Ollama's /api/embed. nomic-embed-text wants a task prefix
 * on each text; other models get the text as is.
 */
export function ollamaEmbedder(host: string, model: string, fetcher: typeof fetch = fetch): Embed {
  const prefixed = /nomic/i.test(model);
  return async (texts, kind) => {
    const input = prefixed ? texts.map((t) => `${kind === 'query' ? 'search_query' : 'search_document'}: ${t}`) : texts;
    const res = await fetcher(`${host.replace(/\/$/, '')}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input, truncate: true }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Ollama embed ${res.status}${/not found/i.test(body) ? ` (run: ollama pull ${model})` : body ? `: ${body.slice(0, 200)}` : ''}`);
    }
    const out = (await res.json()) as { embeddings?: number[][] };
    if (!out.embeddings || out.embeddings.length !== texts.length) throw new Error('Ollama returned no embeddings.');
    return out.embeddings;
  };
}

interface Item {
  /** sha1 of the embedded text, so unchanged text isn't embedded again. */
  hash: string;
  /** Float32 vector, base64, normalised to length 1. */
  vec: string;
  /** The start of the text, shown in results. */
  preview: string;
}

interface IndexFile {
  model: string;
  items: Record<string, Item>;
}

export interface SemanticHit {
  key: string;
  kind: 'note' | 'journal';
  /** The note path, or the journal entry id. */
  ref: string;
  score: number;
  preview: string;
}

/** About this many characters per note chunk, cut at paragraph breaks. */
const CHUNK_CHARS = 1200;
const MAX_CHUNKS_PER_NOTE = 20;
const EMBED_BATCH = 32;
const PREVIEW_CHARS = 240;
/** Below this similarity a hit is noise, not a match. */
export const MIN_SCORE = 0.45;

/** Splits a note into chunks of about CHUNK_CHARS at blank lines, the title leading each so a chunk keeps its context. */
export function chunkNote(path: string, text: string): string[] {
  const title = path.replace(/\.md$/, '');
  const paras = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const chunks: string[] = [];
  let cur = '';
  for (const p of paras) {
    for (let i = 0; i < p.length; i += CHUNK_CHARS) {
      const piece = p.slice(i, i + CHUNK_CHARS);
      if (cur && cur.length + piece.length > CHUNK_CHARS) {
        chunks.push(cur);
        cur = '';
      }
      cur = cur ? `${cur}\n\n${piece}` : piece;
    }
  }
  if (cur) chunks.push(cur);
  if (chunks.length === 0) chunks.push('');
  return chunks.slice(0, MAX_CHUNKS_PER_NOTE).map((c) => `${title}\n${c}`.trim());
}

const sha1 = (s: string) => createHash('sha1').update(s).digest('hex');

function normalise(v: number[]): Float32Array {
  const len = Math.hypot(...v) || 1;
  return Float32Array.from(v, (x) => x / len);
}
const encode = (v: Float32Array) => Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64');
function decode(s: string): Float32Array {
  const b = Buffer.from(s, 'base64');
  return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
}
function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length && i < b.length; i++) s += a[i]! * b[i]!;
  return s;
}

const journalText = (e: JournalEntry) => `${e.channelName} ${e.ongoing?.topic ?? ''}\n${e.summary}`.trim();

export class SemanticIndex {
  private data: IndexFile;
  private vectors = new Map<string, Float32Array>();
  private refreshing?: Promise<number>;
  /** Why the last refresh or search failed, for the startup line and errors. */
  lastError?: string;

  constructor(
    private readonly path: string,
    readonly model: string,
    private readonly embed: Embed,
    private readonly sources: { vault?: Vault; journal?: Journal },
  ) {
    const saved = existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as IndexFile) : undefined;
    // A different model's vectors can't be compared with this one's.
    this.data = saved && saved.model === model ? saved : { model, items: {} };
    for (const [k, it] of Object.entries(this.data.items)) this.vectors.set(k, decode(it.vec));
  }

  get size(): number {
    return this.vectors.size;
  }

  get file(): string {
    return this.path;
  }

  /** Everything that should be in the index right now, by key. */
  private wanted(): Map<string, string> {
    const out = new Map<string, string>();
    const { vault, journal } = this.sources;
    if (vault) {
      for (const path of vault.list()) {
        if (path.startsWith(`${TRAINING_FOLDER}/`) || path.startsWith(`${WORKOUTS_FOLDER}/`)) continue;
        chunkNote(path, vault.read(path) ?? '').forEach((c, i) => out.set(`note:${path}#${i}`, c));
      }
    }
    for (const e of journal?.entries() ?? []) out.set(`journal:${e.id}`, journalText(e));
    return out;
  }

  /** Embeds what's new or changed and drops what's gone. Returns how many items were embedded. One refresh at a time. */
  refresh(): Promise<number> {
    this.refreshing ??= this.doRefresh().finally(() => (this.refreshing = undefined));
    return this.refreshing;
  }

  private async doRefresh(): Promise<number> {
    const wanted = this.wanted();
    let changed = false;
    for (const key of Object.keys(this.data.items)) {
      if (!wanted.has(key)) {
        delete this.data.items[key];
        this.vectors.delete(key);
        changed = true;
      }
    }
    const todo = [...wanted].filter(([k, text]) => this.data.items[k]?.hash !== sha1(text));
    let embedded = 0;
    try {
      for (let i = 0; i < todo.length; i += EMBED_BATCH) {
        const batch = todo.slice(i, i + EMBED_BATCH);
        const vecs = await this.embed(batch.map(([, t]) => t), 'document');
        batch.forEach(([key, text], j) => {
          const v = normalise(vecs[j]!);
          this.data.items[key] = { hash: sha1(text), vec: encode(v), preview: text.replace(/\s+/g, ' ').slice(0, PREVIEW_CHARS) };
          this.vectors.set(key, v);
        });
        embedded += batch.length;
        changed = true;
        // Save as it goes, so a first index of a big vault isn't lost to a restart.
        if (embedded % (EMBED_BATCH * 8) === 0) this.save();
      }
      this.lastError = undefined;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      if (changed) this.save();
    }
    return embedded;
  }

  /** The best matches for a query, best first; one hit per note. */
  async search(query: string, opts: { scope?: 'all' | 'notes' | 'journal'; limit?: number; exclude?: Set<string> } = {}): Promise<SemanticHit[]> {
    const scope = opts.scope ?? 'all';
    const limit = opts.limit ?? 8;
    const [qv] = await this.embed([query], 'query');
    const q = normalise(qv!);
    const best = new Map<string, SemanticHit>();
    for (const [key, v] of this.vectors) {
      const kind = key.startsWith('note:') ? 'note' : 'journal';
      if (scope === 'notes' && kind !== 'note') continue;
      if (scope === 'journal' && kind !== 'journal') continue;
      const ref = kind === 'note' ? key.slice(5).replace(/#\d+$/, '') : key.slice(8);
      if (opts.exclude?.has(ref)) continue;
      const score = dot(q, v);
      if (score < MIN_SCORE) continue;
      const prev = best.get(ref);
      if (!prev || score > prev.score) best.set(ref, { key, kind, ref, score, preview: this.data.items[key]?.preview ?? '' });
    }
    return [...best.values()].sort((a, b) => b.score - a.score).slice(0, limit);
  }

  private save() {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(`${this.path}.tmp`, JSON.stringify(this.data));
    renameSync(`${this.path}.tmp`, this.path);
  }
}

export const SEMANTIC_PROMPT = `
Search by meaning:
- semantic_search finds notes and past conversations by what they're about, not their exact words ("that dumpling place my friend mentioned", "the thing I wanted to fix on the car"). Use it when recall or search_notes come up empty, or when they describe something instead of naming it, before saying you can't find it or asking them.`;

export function semanticTools(index: SemanticIndex, journal: Journal | undefined, timeZone: string): ToolHandler[] {
  const day = (iso: string) => new Intl.DateTimeFormat('en-US', { timeZone, month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(iso));
  return [
    {
      def: {
        name: 'semantic_search',
        description: "Search the owner's notes and your journal of past conversations by meaning, not exact words. Returns note paths and journal entries, best match first.",
        strict: true,
        input_schema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'What it is about, in plain words.' },
            scope: { type: 'string', enum: ['all', 'notes', 'journal'], description: 'Where to look.' },
          },
          required: ['query', 'scope'],
          additionalProperties: false,
        },
      },
      async run(args) {
        const query = String(args.query ?? '').trim();
        if (!query) throw new Error('Give something to search for.');
        let hits: SemanticHit[];
        try {
          hits = await index.search(query, { scope: (args.scope as 'all' | 'notes' | 'journal') || 'all' });
        } catch (err) {
          throw new Error(`Search by meaning is offline (${err instanceof Error ? err.message : String(err)}). Use search_notes or recall instead.`);
        }
        if (hits.length === 0) return index.size ? `Nothing close to "${query}".` : 'The index is still being built; use search_notes or recall for now.';
        const byId = new Map((journal?.entries() ?? []).map((e) => [e.id, e]));
        return hits
          .map((h) => {
            const pct = Math.round(h.score * 100);
            if (h.kind === 'note') return `note ${h.ref} (${pct}%)\n  ${h.preview.slice(h.ref.length - 2).trim().slice(0, 200)}`;
            const e = byId.get(h.ref);
            return e ? `conversation ${day(e.from)} · #${e.channelName} (${pct}%)\n  ${e.summary.replace(/\s+/g, ' ').slice(0, 400)}` : `conversation ${h.ref} (${pct}%)\n  ${h.preview}`;
          })
          .join('\n');
      },
    },
  ];
}
