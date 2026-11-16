import type { Usage } from './llm.js';

/**
 * What the assistant's API calls cost, worked out from the token counts the
 * API reports. These are list prices in US dollars per million tokens, so
 * the totals are an estimate: the Anthropic console has the real bill.
 */
interface Price {
  input: number;
  output: number;
  cacheRead: number;
  /** Writing the 5-minute prompt cache. */
  cacheWrite: number;
}

const PRICES: { match: RegExp; price: Price }[] = [
  { match: /haiku-5-5/, price: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 } },
  { match: /sonnet-5-5/, price: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 } },
  { match: /sonnet-5/, price: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 } },
  { match: /opus-5-5/, price: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 } },
  { match: /opus/, price: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } },
  { match: /haiku/, price: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 } },
  { match: /sonnet/, price: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } },
];

/** Web search is billed per search, $10 per thousand. Fetching a page costs only its tokens. */
const PER_SEARCH = 0.01;

/** Nothing used yet, for adding calls up. */
export const noUsage = (model = ''): Usage => ({ model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, webSearches: 0, webFetches: 0 });

export function addUsage(total: Usage, u: Usage): Usage {
  return {
    model: total.model || u.model,
    input: total.input + u.input,
    output: total.output + u.output,
    cacheRead: total.cacheRead + u.cacheRead,
    cacheWrite: total.cacheWrite + u.cacheWrite,
    webSearches: total.webSearches + u.webSearches,
    webFetches: total.webFetches + u.webFetches,
  };
}

/** Estimated cost of the usage in US dollars; an unknown model is priced like Sonnet 4.6. */
export function costUsd(u: Usage): number {
  const price = PRICES.find((p) => p.match.test(u.model))?.price ?? PRICES.at(-1)!.price;
  const tokens = (u.input * price.input + u.output * price.output + u.cacheRead * price.cacheRead + u.cacheWrite * price.cacheWrite) / 1_000_000;
  return tokens + u.webSearches * PER_SEARCH;
}

/** "$0.42", or "<$0.01" for the tiny amounts Haiku replies cost. */
export function dollars(n: number): string {
  if (n > 0 && n < 0.01) return '<$0.01';
  return `$${n.toFixed(2)}`;
}
