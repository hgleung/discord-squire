import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ToolHandler } from './llm.js';

/**
 * Long-term memory: short facts about the owner that the assistant decides
 * are worth keeping — preferences, routines, people, plans. Every one is put
 * in front of the model on every reply and every background task, so it
 * stays small and curated rather than a log of everything said.
 */
export interface Memory {
  id: string;
  text: string;
  createdAt: string;
  updatedAt: string;
}

export const MAX_MEMORIES = 200;
export const MAX_MEMORY_CHARS = 300;

export class MemoryStore {
  private memories: Memory[] = [];

  constructor(private readonly path: string) {
    if (existsSync(path)) {
      this.memories = (JSON.parse(readFileSync(path, 'utf8')) as { memories?: Memory[] }).memories ?? [];
    }
  }

  get file(): string {
    return this.path;
  }

  list(): Memory[] {
    return [...this.memories];
  }

  /** Saves a memory; `existed` is true when an identical one was already there. */
  add(text: string, now = new Date()): Memory & { existed?: boolean } {
    const clean = check(text);
    const dupe = this.memories.find((m) => m.text.toLowerCase() === clean.toLowerCase());
    if (dupe) return { ...dupe, existed: true };
    if (this.memories.length >= MAX_MEMORIES) {
      throw new Error(`Memory is full (${MAX_MEMORIES}). Merge or forget outdated memories first.`);
    }
    const memory: Memory = { id: randomUUID().slice(0, 6), text: clean, createdAt: now.toISOString(), updatedAt: now.toISOString() };
    this.memories.push(memory);
    this.save();
    return memory;
  }

  update(id: string, text: string, now = new Date()): Memory {
    const memory = this.memories.find((m) => m.id === id);
    if (!memory) throw new Error(`No memory with id "${id}".`);
    memory.text = check(text);
    memory.updatedAt = now.toISOString();
    this.save();
    return memory;
  }

  forget(id: string): Memory {
    const memory = this.memories.find((m) => m.id === id);
    if (!memory) throw new Error(`No memory with id "${id}".`);
    this.memories = this.memories.filter((m) => m.id !== id);
    this.save();
    return memory;
  }

  /** The block that goes into a system prompt, oldest first so it changes only at the end. */
  prompt(): string {
    if (this.memories.length === 0) return '';
    const lines = this.memories.map((m) => `- [${m.id}] ${m.text}`).join('\n');
    return `\n\nWhat you remember about your owner (from earlier conversations; ids are for update_memory / forget_memory):\n${lines}`;
  }

  private save() {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify({ memories: this.memories }, null, 2));
    renameSync(tmp, this.path);
  }
}

function check(text: string): string {
  const clean = text.trim().replace(/\s+/g, ' ');
  if (!clean) throw new Error('Memory text is empty.');
  if (clean.length > MAX_MEMORY_CHARS) throw new Error(`Keep a memory under ${MAX_MEMORY_CHARS} characters; split it or tighten it.`);
  return clean;
}

export const MEMORY_PROMPT = `
Memory:
- You have a long-term memory, listed at the end of this prompt. Use it: let what you know shape answers (their gym split, diet, home airport, who people are) without reciting it back.
- Save with remember when you learn something durable that would make future help better: preferences, routines, goals, recurring plans, people and relationships, places they go, things they've said they like or hate. One fact per memory, written plainly in the third person ("Prefers aisle seats", "Sister Amy lives in Portland").
- Don't save one-off details, things already in the chat that won't matter next week, anything already remembered, or secrets (passwords, card numbers, codes).
- When something changes, update_memory the old one rather than adding a contradiction; forget_memory what's no longer true or when they ask you to forget.
- A standing instruction about how you work ("no need to remind me about…", "don't…", "from now on…") is a preference to save. Save it (or update_memory the memory it changes, so no older memory says the opposite) in the same reply, before saying "got it". Never confirm a preference you didn't save.
- If they tell you to remember something, do it and say so in a couple of words. Otherwise save quietly; no need to announce it.`;

export function memoryTools(store: MemoryStore): ToolHandler[] {
  return [
    {
      def: {
        name: 'remember',
        description: 'Save one durable fact about the owner to long-term memory.',
        strict: true,
        input_schema: {
          type: 'object',
          properties: { text: { type: 'string', description: `One fact, third person, under ${MAX_MEMORY_CHARS} characters.` } },
          required: ['text'],
          additionalProperties: false,
        },
      },
      run(args) {
        const m = store.add(String(args.text ?? ''));
        // Say which it was, so the reply doesn't claim "already saved" for
        // something new (or the reverse).
        return m.existed ? `Already remembered as [${m.id}]; nothing new saved.` : `Saved new memory [${m.id}].`;
      },
    },
    {
      def: {
        name: 'update_memory',
        description: 'Replace the text of an existing memory when the fact has changed or can be stated better.',
        strict: true,
        input_schema: {
          type: 'object',
          properties: { id: { type: 'string' }, text: { type: 'string' } },
          required: ['id', 'text'],
          additionalProperties: false,
        },
      },
      run(args) {
        const m = store.update(String(args.id ?? ''), String(args.text ?? ''));
        return `Updated [${m.id}].`;
      },
    },
    {
      def: {
        name: 'forget_memory',
        description: 'Delete a memory that is wrong, outdated, or that the owner asked you to forget.',
        strict: true,
        input_schema: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
          additionalProperties: false,
        },
      },
      run(args) {
        const m = store.forget(String(args.id ?? ''));
        return `Forgot [${m.id}]: ${m.text}`;
      },
    },
  ];
}
