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

/** Tools that only read, by name; they lose strict first when there are too many. */
const READS = /^(list|read|search|find|get)_|_(events|find|lists|read|search|session|history|week|splits)$/;

/**
 * Keeps strict schema checking on at most MAX_STRICT_TOOLS tools. Strict
 * matters most where a malformed call changes something, so it comes off
 * tools with no inputs first, then read-only ones, then the latest in order.
 */
export function limitStrict<T extends { name: string; strict?: boolean; input_schema: { properties: Record<string, unknown> } }>(tools: T[]): T[] {
  const strict = tools.filter((t) => t.strict);
  if (strict.length <= MAX_STRICT_TOOLS) return tools;
  const rank = (t: T) => (Object.keys(t.input_schema.properties).length === 0 ? 0 : READS.test(t.name) ? 1 : 2);
  const keep = new Set(
    strict
      .map((t, i) => ({ t, i }))
      .sort((a, b) => rank(b.t) - rank(a.t) || a.i - b.i)
      .slice(0, MAX_STRICT_TOOLS)
      .map(({ t }) => t),
  );
  return tools.map((t) => (t.strict && !keep.has(t) ? { ...t, strict: false } : t));
}

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
export function fromMessage(response: Pick<Anthropic.Beta.BetaMessage, 'content' | 'stop_reason'>): Generation {
  let text = '';
  const sources = new Sources();
  const calls: Generation['calls'] = [];
  for (const block of response.content) {
    if (block.type === 'text') {
      text += block.text;
      for (const c of block.citations ?? []) {
        if (c.type === 'web_search_result_location' && c.url) sources.pages.set(c.url, c.title ?? c.url);
      }
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
  return { stop, text, calls, sources, turn: { role: 'assistant', text, calls, native: response.content } };
}

export class AnthropicLLM implements LLM {
  // Created on first use, so checks that never call the API need no key.
  private client?: Anthropic;

  async generate(opts: ModelOptions, req: GenerateRequest): Promise<Generation> {
    const response = await (this.client ??= new Anthropic()).beta.messages.create({
      model: opts.model,
      max_tokens: 16000,
      system: req.system,
      tools: [...webTools(opts.model, req.web.maxUses, req.web.location), ...limitStrict(req.tools)],
      messages: toMessages(req.turns),
      output_config: { effort: opts.effort },
      cache_control: { type: 'ephemeral' },
      // If the model declines on a safety classifier, the API reruns the
      // request on a fallback model in the same call rather than failing.
      // Haiku has no server-side fallback, so it goes without.
      ...(isHaiku(opts.model) ? {} : { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const }),
    });
    return fromMessage(response);
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
