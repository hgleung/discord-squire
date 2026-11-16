import Anthropic from '@anthropic-ai/sdk';
import { Sources, type Generation, type GenerateRequest, type ImagePart, type LLM, type Location, type ModelOptions, type StopReason, type Turn } from './llm.js';

type Block = Anthropic.Beta.BetaContentBlockParam;

const isHaiku = (model: string) => model.includes('haiku');

/**
 * Anthropic-hosted web search and fetch. Haiku takes the basic variants;
 * Sonnet and up take the newer ones, which filter results before they reach
 * the model.
 */
export function webTools(model: string, maxUses = 5, location?: Location): Anthropic.Beta.BetaToolUnion[] {
  if (maxUses <= 0) return [];
  // Localises results ("weather", "pharmacy near me") to the owner's home.
  const user_location = location ? { type: 'approximate' as const, ...location } : undefined;
  return isHaiku(model)
    ? [
        { type: 'web_search_20250305', name: 'web_search', max_uses: maxUses, user_location },
        { type: 'web_fetch_20250910', name: 'web_fetch', max_uses: maxUses },
      ]
    : [
        { type: 'web_search_20260209', name: 'web_search', max_uses: maxUses, user_location },
        { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: maxUses },
      ];
}

/** The API rejects a request with more strict tools than this. */
export const MAX_STRICT_TOOLS = 20;

/**
 * The API also compiles all strict schemas into one grammar with a size
 * limit, which the count alone doesn't capture. Measured on the assistant's
 * tools: 7,445 characters of schema JSON passed and 7,688 failed. This keeps
 * well under that, so a tool that grows a field doesn't break every reply.
 */
export const MAX_STRICT_SCHEMA_CHARS = 6_000;

/** Tools that only read, by name; they lose strict first when there are too many. */
const READS = /^(list|read|search|find|get)_|_(events|find|lists|read|search|session|history|week|splits)$/;

const schemaSize = (t: { input_schema: unknown }) => JSON.stringify(t.input_schema).length;

/**
 * Keeps strict schema checking on as many tools as the API allows, by count
 * and by schema size. Strict matters most where a malformed call changes
 * something, so it comes off tools with no inputs first, then read-only ones,
 * then the latest in order.
 */
export function limitStrict<T extends { name: string; strict?: boolean; input_schema: { properties: Record<string, unknown> } }>(tools: T[]): T[] {
  const strict = tools.filter((t) => t.strict);
  if (strict.length <= MAX_STRICT_TOOLS && strict.reduce((n, t) => n + schemaSize(t), 0) <= MAX_STRICT_SCHEMA_CHARS) return tools;
  const rank = (t: T) => (Object.keys(t.input_schema.properties).length === 0 ? 0 : READS.test(t.name) ? 1 : 2);
  const keep = new Set<T>();
  let size = 0;
  for (const { t } of strict.map((t, i) => ({ t, i })).sort((a, b) => rank(b.t) - rank(a.t) || a.i - b.i)) {
    if (keep.size >= MAX_STRICT_TOOLS) break;
    // A large schema that doesn't fit is skipped; smaller ones after it may.
    if (size + schemaSize(t) > MAX_STRICT_SCHEMA_CHARS) continue;
    keep.add(t);
    size += schemaSize(t);
  }
  return tools.map((t) => (t.strict && !keep.has(t) ? { ...t, strict: false } : t));
}

/** The API refused the strict schemas as too large to compile together. */
export const grammarTooLarge = (err: unknown) => err instanceof Anthropic.BadRequestError && /grammar is too large/i.test(err.message);

type MediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

/** Downloaded images go inline; anything else is left for the API to fetch. */
const imageBlock = (p: ImagePart): Anthropic.Beta.BetaImageBlockParam =>
  p.data ? { type: 'image', source: { type: 'base64', media_type: p.mimeType as MediaType, data: p.data } } : { type: 'image', source: { type: 'url', url: p.url } };

/** The conversation as Messages API turns; consecutive same-role turns are merged. */
export function toMessages(turns: Turn[]): Anthropic.Beta.BetaMessageParam[] {
  const out: { role: 'user' | 'assistant'; content: Block[] }[] = [];
  const push = (role: 'user' | 'assistant', blocks: Block[]) => {
    if (blocks.length === 0) return;
    const last = out.at(-1);
    if (last?.role === role) last.content.push(...blocks);
    else out.push({ role, content: [...blocks] });
  };
  for (const t of turns) {
    if (t.role === 'user') {
      push('user', t.content.map((p): Block => (p.type === 'text' ? { type: 'text', text: p.text } : imageBlock(p))));
    } else if (t.role === 'tool') {
      push('user', [
        ...t.results.map(
          (r): Block => ({
            type: 'tool_result',
            tool_use_id: r.callId,
            content: r.images?.length ? [{ type: 'text', text: r.content }, ...r.images.map(imageBlock)] : r.content,
            ...(r.isError ? { is_error: true } : {}),
          }),
        ),
        ...(t.note ? [{ type: 'text' as const, text: t.note }] : []),
      ]);
    } else if (t.native) {
      push('assistant', t.native as Block[]);
    } else {
      push('assistant', [
        ...(t.text ? [{ type: 'text' as const, text: t.text }] : []),
        ...(t.calls ?? []).map((c): Block => ({ type: 'tool_use', id: c.id, name: c.name, input: c.input })),
      ]);
    }
  }
  return out;
}

/** A Messages API response as a neutral Generation. */
export function fromMessage(
  response: Pick<Anthropic.Beta.BetaMessage, 'content' | 'stop_reason'> & Partial<Pick<Anthropic.Beta.BetaMessage, 'usage' | 'model'>>,
): Generation {
  let text = '';
  const sources = new Sources();
  const calls: Generation['calls'] = [];
  for (const block of response.content) {
    if (block.type === 'text') {
      text += block.text;
      for (const c of block.citations ?? []) {
        if (c.type === 'web_search_result_location' && c.url) sources.pages.set(c.url, c.title ?? c.url);
      }
    } else if (block.type === 'web_fetch_tool_result' && block.content.type === 'web_fetch_result') {
      sources.opened.set(block.content.url, block.content.content.title ?? block.content.url);
    } else if (block.type === 'tool_use') {
      calls.push({ id: block.id, name: block.name, input: (block.input ?? {}) as Record<string, unknown> });
    }
  }
  const stop: StopReason =
    response.stop_reason === 'refusal'
      ? 'refusal'
      : // pause_turn: the server-side search loop hit its own limit; sending
        // the turn back lets it carry on where it stopped.
        response.stop_reason === 'pause_turn'
        ? 'pause'
        : response.stop_reason === 'tool_use'
          ? 'tool_use'
          : 'done';
  const u = response.usage;
  const usage = u
    ? {
        model: response.model ?? '',
        input: u.input_tokens ?? 0,
        output: u.output_tokens ?? 0,
        cacheRead: u.cache_read_input_tokens ?? 0,
        cacheWrite: u.cache_creation_input_tokens ?? 0,
        webSearches: u.server_tool_use?.web_search_requests ?? 0,
        webFetches: u.server_tool_use?.web_fetch_requests ?? 0,
      }
    : undefined;
  return { stop, text, calls, sources, turn: { role: 'assistant', text, calls, native: response.content }, usage };
}

export class AnthropicLLM implements LLM {
  // Created on first use, so checks that never call the API need no key.
  private client?: Anthropic;

  async generate(opts: ModelOptions, req: GenerateRequest): Promise<Generation> {
    const tools = limitStrict(req.tools);
    try {
      return await this.create(opts, req, tools);
    } catch (err) {
      // The size limit isn't published, so the budget above is a guess. If
      // it's ever wrong, answer without strict checking rather than fail.
      if (!grammarTooLarge(err)) throw err;
      console.warn(`[assistant] strict tool schemas too large to compile (${tools.filter((t) => t.strict).length} strict); retrying without strict`);
      return this.create(opts, req, tools.map((t) => ({ ...t, strict: false })));
    }
  }

  private async create(opts: ModelOptions, req: GenerateRequest, tools: GenerateRequest['tools']): Promise<Generation> {
    const response = await (this.client ??= new Anthropic()).beta.messages.create({
      model: opts.model,
      max_tokens: 16000,
      system: req.system,
      tools: [...webTools(opts.model, req.web.maxUses, req.web.location), ...tools],
      messages: toMessages(req.turns),
      output_config: { effort: opts.effort },
      cache_control: { type: 'ephemeral' },
      // If the model declines on a safety classifier, the API reruns the
      // request on a fallback model in the same call rather than failing.
      // Haiku has no server-side fallback, so it goes without.
      ...(isHaiku(opts.model) ? {} : { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const }),
    });
    const gen = fromMessage(response);
    if (gen.usage && !gen.usage.model) gen.usage.model = opts.model;
    return gen;
  }

  retryable(err: unknown): boolean {
    return (
      err instanceof Anthropic.RateLimitError ||
      err instanceof Anthropic.InternalServerError ||
      err instanceof Anthropic.APIConnectionError ||
      (err instanceof Anthropic.APIError && (err.status ?? 0) >= 500)
    );
  }
}
