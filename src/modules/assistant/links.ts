/**
 * Opening what the owner links or pastes: short links, Discord image links,
 * Discord message links, and web pages that Anthropic's own fetcher can't
 * reach. Everything here runs on the bot's machine.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/** A browser-like agent; plenty of sites turn away anything that isn't one. */
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;
/** The API's limit for one base64 image. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_PAGE_BYTES = 4 * 1024 * 1024;
/** How much page text goes back to the model. */
const MAX_PAGE_CHARS = 20_000;

export const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** The http(s) links in a message, without the punctuation that often trails them. */
export function findUrls(text: string): string[] {
  const found = text.match(/https?:\/\/[^\s<>()"'`]+/gi) ?? [];
  return [...new Set(found.map((u) => u.replace(/[.,;:!?*_~|\]]+$/, '')))];
}

/** Redirect-only hosts; the page behind them is somewhere else. */
const SHORTENERS = new Set([
  't.co', 'bit.ly', 'tinyurl.com', 'goo.gl', 'ow.ly', 'buff.ly', 'lnkd.in', 'is.gd', 'rb.gy', 'cutt.ly', 'tiny.cc',
  'shorturl.at', 'amzn.to', 'a.co', 'trib.al', 'dlvr.it', 'fb.me', 'spoti.fi', 'pin.it', 'vm.tiktok.com', 'maps.app.goo.gl',
]);

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
};

export const isShortLink = (url: string) => SHORTENERS.has(hostOf(url));

/** A Discord attachment link pasted as text (not an upload). */
export const isDiscordCdn = (url: string) => {
  const host = hostOf(url);
  return (host === 'cdn.discordapp.com' || host === 'media.discordapp.net') && new URL(url).pathname.startsWith('/attachments/');
};

/** discord.com/channels/<guild>/<channel>[/<message>], or undefined. */
export function parseDiscordLink(url: string): { guildId: string; channelId: string; messageId?: string } | undefined {
  const m = url.match(/^https?:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/channels\/(\d+|@me)\/(\d+)(?:\/(\d+))?/i);
  return m ? { guildId: m[1]!, channelId: m[2]!, ...(m[3] ? { messageId: m[3] } : {}) } : undefined;
}

/** Private, loopback and link-local ranges: nothing on the owner's network is fetched for the model. */
export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 6) {
    const v6 = ip.toLowerCase();
    if (v6.startsWith('::ffff:')) return isPrivateAddress(v6.slice(7));
    return v6 === '::1' || v6 === '::' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6);
  }
  const [a, b] = ip.split('.').map(Number) as [number, number];
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

export async function assertPublic(url: URL) {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`Only http and https links can be opened, not ${url.protocol}`);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) throw new Error(`${url.hostname} is a private address; it can't be opened.`);
}

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

/**
 * GET with redirects followed by hand, so every hop is checked against the
 * private-address rule before it is requested.
 */
async function safeGet(url: string, accept: string, fetcher: Fetcher, check = assertPublic): Promise<Response> {
  let current = new URL(url);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await check(current);
    const res = await fetcher(current.href, {
      headers: { 'User-Agent': USER_AGENT, Accept: accept, 'Accept-Language': 'en-US,en;q=0.9' },
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      await res.body?.cancel();
      current = new URL(location, current);
      continue;
    }
    return Object.defineProperty(res, 'url', { value: current.href });
  }
  throw new Error(`Too many redirects from ${url}`);
}

/** Reads a body up to a size limit, so a huge download can't fill memory. */
async function readCapped(res: Response, limit: number): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > limit) {
    await res.body?.cancel();
    throw new Error(`it's ${(declared / 1048576).toFixed(1)} MB, over the ${(limit / 1048576).toFixed(0)} MB limit`);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of res.body ?? []) {
    size += chunk.length;
    if (size > limit) throw new Error(`it's over the ${(limit / 1048576).toFixed(0)} MB limit`);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * Where a short link leads, by following its redirects without opening the
 * page at the end. Anthropic's fetcher only opens links that appear in the
 * conversation, so a t.co link is useless to it until it's spelled out.
 */
export async function expandShortLink(url: string, fetcher: Fetcher = fetch, check = assertPublic): Promise<string> {
  let current = new URL(url);
  for (let hop = 0; hop <= MAX_REDIRECTS && SHORTENERS.has(hostOf(current.href)); hop++) {
    await check(current);
    const res = await fetcher(current.href, { headers: { 'User-Agent': USER_AGENT }, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
    const location = res.headers.get('location');
    // t.co answers browsers with a page that refreshes to the target.
    const body = location ? '' : (await readCapped(res, 512 * 1024).catch(() => Buffer.alloc(0))).toString('utf8');
    await res.body?.cancel().catch(() => {});
    const next = location ?? body.match(/<meta[^>]+http-equiv=["']?refresh["']?[^>]+url=([^"'>\s]+)/i)?.[1] ?? body.match(/location\.replace\(["']([^"']+)/)?.[1];
    if (!next) break;
    current = new URL(decodeEntities(next.replace(/\\\//g, '/')), current);
  }
  return current.href;
}

export interface FetchedImage {
  data: string;
  mimeType: string;
}

/** Downloads an image for the model, as base64. */
export async function fetchImage(url: string, fetcher: Fetcher = fetch, check = assertPublic): Promise<FetchedImage> {
  const res = await safeGet(url, 'image/*', fetcher, check);
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(res.status === 404 || res.status === 403 ? `the link has expired or was removed (HTTP ${res.status})` : `HTTP ${res.status}`);
  }
  const mimeType = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (!IMAGE_TYPES.has(mimeType)) {
    await res.body?.cancel();
    throw new Error(mimeType ? `it's ${mimeType}, not a PNG, JPEG, GIF or WebP image` : "it isn't an image");
  }
  return { data: (await readCapped(res, MAX_IMAGE_BYTES)).toString('base64'), mimeType };
}

/** Discord's media proxy serves a resized copy of an attachment, for images over the size limit. */
export function resizedDiscordUrl(url: string, width: number, height: number, max = 1568): string {
  const u = new URL(url);
  u.hostname = 'media.discordapp.net';
  const scale = Math.min(1, max / Math.max(width, height));
  u.searchParams.set('width', String(Math.round(width * scale)));
  u.searchParams.set('height', String(Math.round(height * scale)));
  u.searchParams.set('format', 'jpeg');
  return u.href;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', frac12: '½', frac14: '¼', frac34: '¾', deg: '°', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z0-9]+);/gi, (whole, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[e.toLowerCase()] ?? whole;
  });
}

/** A page's readable text: no scripts, styles or menus, one block per line. */
export function htmlToText(html: string): string {
  const body = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|svg|nav|footer|header|form|iframe|template)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/(p|div|section|article|li|ul|ol|h[1-6]|tr|table|blockquote|pre)>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  return decodeEntities(body)
    .split('\n')
    .map((l) => l.replace(/[ \t ]+/g, ' ').trim())
    .filter((l, i, all) => l && !(l === '-' || (i > 0 && l === all[i - 1])))
    .join('\n');
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

const asText = (v: Json | undefined): string =>
  v == null ? '' : typeof v === 'string' ? decodeEntities(v).trim() : typeof v === 'number' ? String(v) : Array.isArray(v) ? v.map(asText).filter(Boolean).join(', ') : asText((v as Record<string, Json>).name ?? (v as Record<string, Json>).text);

/** Recipe steps, flattened out of HowToSection and HowToStep. */
function steps(v: Json | undefined): string[] {
  if (v == null) return [];
  if (typeof v === 'string') return htmlToText(v).split('\n').filter(Boolean);
  if (Array.isArray(v)) return v.flatMap(steps);
  if (typeof v === 'object') {
    const o = v as Record<string, Json>;
    if (o.itemListElement) return [...(o.name ? [`${asText(o.name)}:`] : []), ...steps(o.itemListElement)];
    return o.text ? [asText(o.text)] : o.name ? [asText(o.name)] : [];
  }
  return [];
}

/**
 * A recipe from the page's structured data (schema.org JSON-LD), which most
 * recipe sites include and which survives layouts that confuse plain text.
 */
export function recipeFromHtml(html: string): string | undefined {
  for (const m of html.matchAll(/<script[^>]+type=["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi)) {
    let data: Json;
    try {
      data = JSON.parse(m[1]!.trim()) as Json;
    } catch {
      continue;
    }
    const queue: Json[] = [data];
    while (queue.length) {
      const node = queue.shift();
      if (Array.isArray(node)) queue.push(...node);
      else if (node && typeof node === 'object') {
        const types = ([] as Json[]).concat(node['@type'] ?? []);
        if (types.includes('Recipe')) {
          const lines = [`Recipe: ${asText(node.name)}`];
          if (node.recipeYield) lines.push(`Yield: ${asText(node.recipeYield)}`);
          for (const [k, label] of [['prepTime', 'Prep'], ['cookTime', 'Cook'], ['totalTime', 'Total']] as const) if (node[k]) lines.push(`${label}: ${asText(node[k])}`);
          const ingredients = ([] as Json[]).concat(node.recipeIngredient ?? []).map(asText).filter(Boolean);
          if (ingredients.length) lines.push('Ingredients:', ...ingredients.map((i) => `- ${i}`));
          const method = steps(node.recipeInstructions);
          if (method.length) lines.push('Steps:', ...method.map((s, i) => `${i + 1}. ${s}`));
          if (node.recipeNotes) lines.push(`Notes: ${asText(node.recipeNotes)}`);
          return lines.join('\n');
        }
        if (node['@graph']) queue.push(node['@graph']);
      }
    }
  }
  return undefined;
}

/** Signs that the reply is a bot check rather than the page. */
const CHALLENGE = /Attention Required! \| Cloudflare|Just a moment\.\.\.|cf-browser-verification|challenges\.cloudflare\.com|Access denied \| [^<]* used Cloudflare|px-captcha|Pardon Our Interruption/i;

/**
 * Opens a web page from the bot's own machine and returns its title, any
 * recipe it carries, and its readable text. Throws with a plain reason when
 * the site refuses.
 */
export async function fetchPage(url: string, fetcher: Fetcher = fetch, check = assertPublic): Promise<string> {
  const res = await safeGet(url, 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5', fetcher, check);
  const type = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  const raw = (await readCapped(res, MAX_PAGE_BYTES)).toString('utf8');
  if (CHALLENGE.test(raw) || ((res.status === 403 || res.status === 503) && /cloudflare/i.test(res.headers.get('server') ?? ''))) {
    throw new Error(`${hostOf(res.url)} shows a bot check instead of the page, so it can't be read automatically. Ask your owner to paste the text or send a screenshot.`);
  }
  if (!res.ok) throw new Error(`${hostOf(res.url)} answered HTTP ${res.status}${res.status === 404 ? ' (page not found)' : ''}.`);
  if (type && !/html|xml|text\/plain|json/.test(type)) throw new Error(`That link is a ${type} file, not a web page.`);

  const isHtml = /html|xml/.test(type) || /<html|<body/i.test(raw);
  const title = isHtml ? decodeEntities(raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? '') : '';
  const recipe = isHtml ? recipeFromHtml(raw) : undefined;
  let text = isHtml ? htmlToText(raw.match(/<body[\s\S]*<\/body>/i)?.[0] ?? raw) : raw;
  const room = MAX_PAGE_CHARS - (recipe?.length ?? 0);
  if (text.length > room) text = `${text.slice(0, Math.max(room, 2000))}\n[…page cut short]`;
  return [`URL: ${res.url}`, title && `Title: ${title}`, recipe && `\n${recipe}\n\nPage text:`, text].filter(Boolean).join('\n');
}
