/**
 * The assistant's conversation format, tool contract, and citations, shared
 * by the chat agent and background tasks. anthropic.ts translates it to and
 * from the Messages API; no other file sees an SDK type.
 */

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Where the owner is by default, for localised search results. */
export interface Location {
  city?: string;
  region?: string;
  /** Two-letter ISO country code. */
  country?: string;
  timezone?: string;
}

/** Who the owner is, as configured in .env; folded into system prompts. */
export interface OwnerProfile {
  location?: Location;
  /** Free text: where they work, preferences, anything worth always knowing. */
  about?: string;
}

/** The "About your owner" block for a system prompt, or '' when nothing is set. */
export function profilePrompt(profile: OwnerProfile | undefined): string {
  if (!profile) return '';
  const lines: string[] = [];
  const loc = profile.location;
  const place = [loc?.city, loc?.region, loc?.country].filter(Boolean).join(', ');
  if (place) lines.push(`- Home / default location: ${place}. Assume this for anything location-dependent (weather, "near me", commute, opening hours) unless they say otherwise or the channel or conversation points somewhere else.`);
  if (profile.about) lines.push(`- ${profile.about}`);
  return lines.length ? `\n\nAbout your owner:\n${lines.join('\n')}` : '';
}

export interface ModelOptions {
  model: string;
  effort: Effort;
}

/** A custom tool's declaration: a name, what it's for, and a JSON Schema for its input. */
export interface ToolDef {
  name: string;
  description: string;
  /** Anthropic: hold the model to the schema exactly. */
  strict?: boolean;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
}

/** A custom tool: its definition plus what runs when the model calls it. */
export interface ToolHandler {
  def: ToolDef;
  run(input: Record<string, unknown>): ToolOutput | Promise<ToolOutput>;
}

export const toolMap = (handlers: ToolHandler[]) => new Map(handlers.map((h) => [h.def.name, h]));

/** An image goes by URL for the API to fetch, or as base64 `data` already downloaded. */
export type ImagePart = { type: 'image'; url: string; mimeType: string; data?: string };
export type UserPart = { type: 'text'; text: string } | ImagePart;

/** What a tool returns: text, or text with images for the model to look at. */
export type ToolOutput = string | { content: string; images?: ImagePart[] };

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  callId: string;
  name: string;
  content: string;
  images?: ImagePart[];
  isError?: boolean;
}

/**
 * The model's turn exactly as the API returned it. It has to be sent back
 * verbatim (server-side search results ride along in it).
 */
export type AssistantTurn = { role: 'assistant'; text: string; calls?: ToolCall[]; native?: unknown };

export type Turn =
  | { role: 'user'; content: UserPart[] }
  | AssistantTurn
  /** Results of the custom tools the last assistant turn called, plus an optional note from the app. */
  | { role: 'tool'; results: ToolResult[]; note?: string };

export interface GenerateRequest {
  system: string;
  tools: ToolDef[];
  turns: Turn[];
  /** Web search and page reading, run on the provider's side. */
  web: { maxUses: number; location?: Location };
}

/**
 * done: a final answer. tool_use: custom tools to run, then call again.
 * pause: the provider's own search loop stopped early; call again as is.
 * refusal: the model declined.
 */
export type StopReason = 'done' | 'tool_use' | 'pause' | 'refusal';

/** What one API call used, for the activity log and /usage. */
export interface Usage {
  /** The model that answered, which can differ from the one asked for after a fallback. */
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  webSearches: number;
  webFetches: number;
}

export interface Generation {
  stop: StopReason;
  /** The visible text of this turn. */
  text: string;
  calls: ToolCall[];
  sources: Sources;
  /** What to append to the conversation before calling again. */
  turn: AssistantTurn;
  /** Tokens and server tool calls, when the provider reports them. */
  usage?: Usage;
}

/** The model API. Holds its own client; the model is chosen per call. */
export interface LLM {
  generate(model: ModelOptions, req: GenerateRequest): Promise<Generation>;
  /** Whether a failed call is worth trying again later: rate limits, outages, dropped connections. */
  retryable(err: unknown): boolean;
}

/** Runs the custom tool calls of a turn; failures become error results. */
export async function runTools(
  calls: ToolCall[],
  handlers: Map<string, ToolHandler>,
  skip: Set<string> = new Set(),
): Promise<ToolResult[]> {
  const results: ToolResult[] = [];
  for (const call of calls) {
    if (skip.has(call.name)) continue;
    const handler = handlers.get(call.name);
    try {
      if (!handler) throw new Error(`Unknown tool ${call.name}.`);
      const out = await handler.run(call.input);
      results.push(typeof out === 'string' ? { callId: call.id, name: call.name, content: out } : { callId: call.id, name: call.name, ...out });
    } catch (err) {
      results.push({ callId: call.id, name: call.name, content: err instanceof Error ? err.message : String(err), isError: true });
    }
  }
  return results;
}

/** The web pages a reply cited. */
export class Sources {
  /** url → title */
  readonly pages = new Map<string, string>();
  /** url → title of pages web_fetch actually opened (not just found in a search). */
  readonly opened = new Map<string, string>();

  merge(other: Sources) {
    for (const [url, title] of other.pages) this.pages.set(url, title);
    for (const [url, title] of other.opened) this.opened.set(url, title);
  }

  /** A short "Sources:" footer; angle brackets stop Discord unfurling each link. */
  footer(): string {
    if (this.pages.size === 0) return '';
    const list = [...this.pages].slice(0, 3).map(([url, title]) => `[${title.replace(/[[\]]/g, '')}](<${url}>)`);
    return `\n-# Sources: ${list.join(' · ')}`;
  }
}
