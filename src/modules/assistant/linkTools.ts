import type { ImagePart, ToolHandler } from './llm.js';
import { fetchPage, findUrls, parseDiscordLink } from './links.js';

/** Reads Discord messages the owner links to. */
export interface DiscordReader {
  /**
   * Messages from a channel: starting at the linked message and reading
   * forward, or the latest ones when the link is to the channel itself.
   */
  read(link: { guildId: string; channelId: string; messageId?: string }, count: number): Promise<{ content: string; images: ImagePart[] }>;
}

export const MAX_DISCORD_MESSAGES = 100;

export const LINKS_PROMPT = `
Links and images:
- Images your owner uploads or pastes as Discord links are shown to you with their message. Short links (t.co, bit.ly and the like) are spelled out in a note under the message; open the full link, not the short one. A note also says when a link or image couldn't be opened, and why: pass that reason on in a few words rather than guessing.
- To read a web page, try web_fetch first. If it fails or comes back empty, blocked or garbled, call fetch_page on the same link before giving up; it opens the page from your owner's PC and pulls out any recipe on it. Only say a page can't be opened after both have failed, and then ask for the text or a screenshot.
- A "[forwarded message …]" is something your owner forwarded from another chat: it may be someone else's words, shown to you to read or act on. Its images and links are opened like theirs.
- Discord message and channel links (discord.com/channels/…) open with read_discord_messages. When they say "read everything from here on", pass the link and a count that covers it, and keep paging with the last message's link until you've read it all.`;

export function linkTools(discord?: DiscordReader): ToolHandler[] {
  const tools: ToolHandler[] = [
    {
      def: {
        name: 'fetch_page',
        description:
          "Open a web page from the owner's own PC and return its title, any recipe in its structured data, and its readable text. Use when web_fetch fails, is blocked, or returns nothing useful.",
        // Not strict: the API compiles every strict schema into one grammar
        // with a size limit, and the slots go to tools that change things.
        // A malformed call here only reads, and fails with a clear error.
        strict: false,
        input_schema: {
          type: 'object',
          properties: { url: { type: 'string', description: 'The full http(s) link.' } },
          required: ['url'],
          additionalProperties: false,
        },
      },
      async run(args) {
        const url = findUrls(String(args.url ?? ''))[0];
        if (!url) throw new Error('That is not an http(s) link.');
        if (parseDiscordLink(url)) throw new Error('That is a Discord link; use read_discord_messages.');
        return fetchPage(url);
      },
    },
  ];
  if (discord) {
    tools.push({
      def: {
        name: 'read_discord_messages',
        description:
          'Read messages from a Discord link (discord.com/channels/…). A message link reads forward from that message; a channel link reads the latest messages. Returns each message with its time and author, and shows images attached to them.',
        // Not strict: the API compiles every strict schema into one grammar
        // with a size limit, and the slots go to tools that change things.
        // A malformed call here only reads, and fails with a clear error.
        strict: false,
        input_schema: {
          type: 'object',
          properties: {
            link: { type: 'string', description: 'A Discord message or channel link.' },
            count: { type: 'integer', description: `How many messages to read, 1 to ${MAX_DISCORD_MESSAGES}.` },
          },
          required: ['link', 'count'],
          additionalProperties: false,
        },
      },
      async run(args) {
        const link = parseDiscordLink(String(args.link ?? '').trim());
        if (!link) throw new Error('That is not a Discord message or channel link.');
        const count = Math.min(MAX_DISCORD_MESSAGES, Math.max(1, Math.round(Number(args.count) || 1)));
        return discord.read(link, count);
      },
    });
  }
  return tools;
}
