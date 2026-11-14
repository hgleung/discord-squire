/**
 * The Discord side of opening links: downloading what the owner attaches or
 * pastes, and reading the messages they link to.
 */
import { PermissionFlagsBits, type Attachment, type Client, type Collection, type Message } from 'discord.js';
import type { ChatLine } from './history.js';
import type { ImagePart } from './llm.js';
import { expandShortLink, fetchImage, findUrls, IMAGE_TYPES, isDiscordCdn, isShortLink, MAX_IMAGE_BYTES, parseDiscordLink, resizedDiscordUrl } from './links.js';
import type { DiscordReader } from './linkTools.js';
import { toLocalShort } from './time.js';

/** Images per message shown to the model; the rest are only named. */
const MAX_IMAGES = 8;
/** Characters of linked messages returned in one read. */
const MAX_READ_CHARS = 40_000;

const reason = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Downloads an attachment, through Discord's resizing proxy when it is over
 * the API's size limit. Downloading here, not leaving the URL for the API to
 * fetch, means a link the API can't reach doesn't fail the whole reply.
 */
async function attachmentImage(a: Pick<Attachment, 'url' | 'size' | 'width' | 'height' | 'contentType' | 'name'>): Promise<ImagePart> {
  const mimeType = a.contentType?.split(';')[0] ?? '';
  const tooBig = a.size > MAX_IMAGE_BYTES && a.width && a.height;
  const url = tooBig ? resizedDiscordUrl(a.url, a.width!, a.height!) : a.url;
  const image = await fetchImage(url);
  return { type: 'image', url: a.url, mimeType: image.mimeType || mimeType, data: image.data };
}

const isImage = (a: Pick<Attachment, 'contentType'>) => IMAGE_TYPES.has(a.contentType?.split(';')[0] ?? '');

/** Downloads a message's image attachments; failures become notes. */
async function imagesOf(attachments: Collection<string, Attachment> | Attachment[], room: number, notes: string[]): Promise<ImagePart[]> {
  const images: ImagePart[] = [];
  for (const a of [...attachments.values()].filter(isImage)) {
    if (images.length >= room) {
      notes.push(`${a.name} not shown: only ${room} images are shown at once`);
      continue;
    }
    try {
      images.push(await attachmentImage(a));
    } catch (err) {
      notes.push(`couldn't open the image ${a.name}: ${reason(err)}`);
    }
  }
  return images;
}

/**
 * Opens what one of the owner's messages carries before the model sees it:
 * downloads its images and any Discord image links in its text, spells out
 * short links, and opens a linked Discord message. Anything that fails is
 * noted on the line with the reason, so the model can say what went wrong.
 */
export async function openLinks(message: Message, line: ChatLine, reader: DiscordReader): Promise<ChatLine> {
  const notes: string[] = [];
  const images = await imagesOf(message.attachments, MAX_IMAGES, notes);
  for (const url of findUrls(message.content)) {
    try {
      if (isShortLink(url)) {
        const target = await expandShortLink(url);
        notes.push(target === url ? `${url} didn't lead anywhere` : `${url} leads to ${target}`);
      } else if (isDiscordCdn(url)) {
        if (images.length >= MAX_IMAGES) continue;
        const image = await fetchImage(url);
        images.push({ type: 'image', url, mimeType: image.mimeType, data: image.data });
        notes.push(`the image at ${url.split('?')[0]} is shown above`);
      } else {
        const link = parseDiscordLink(url);
        if (link?.messageId) {
          const { content, images: linked } = await reader.read(link, 1);
          notes.push(`linked Discord message: ${content}`);
          images.push(...linked.slice(0, MAX_IMAGES - images.length));
        }
      }
    } catch (err) {
      notes.push(`couldn't open ${url.split('?')[0]}: ${reason(err)}`);
    }
  }
  return { ...line, images, notes };
}

/** Reads linked messages, only from channels the owner can see themselves. */
export function discordReader(client: Client, ownerId: string | undefined, timeZone: string): DiscordReader {
  return {
    async read(link, count) {
      const channel = await client.channels.fetch(link.channelId).catch(() => null);
      if (!channel || !channel.isTextBased() || !('messages' in channel)) throw new Error("That channel doesn't exist or isn't one I can read.");
      if ('guildId' in channel && channel.guildId !== link.guildId) throw new Error("That link doesn't match its server.");
      if (ownerId && 'permissionsFor' in channel && 'guild' in channel) {
        // Fetched, not taken from the cache, which may not hold the owner yet.
        const member = await channel.guild.members.fetch(ownerId).catch(() => null);
        const perms = member && channel.permissionsFor(member);
        if (!perms?.has(PermissionFlagsBits.ViewChannel) || !perms.has(PermissionFlagsBits.ReadMessageHistory)) {
          throw new Error("You can't see that channel, so I won't read it.");
        }
      }

      const messages: Message[] = [];
      if (link.messageId) {
        const first = await channel.messages.fetch(link.messageId).catch(() => null);
        if (!first) throw new Error('That message was deleted or never existed.');
        messages.push(first);
        let after = first.id;
        while (messages.length < count) {
          const page = await channel.messages.fetch({ after, limit: Math.min(100, count - messages.length) });
          if (page.size === 0) break;
          const sorted = [...page.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
          messages.push(...sorted);
          after = sorted.at(-1)!.id;
        }
      } else {
        const page = await channel.messages.fetch({ limit: count });
        messages.push(...[...page.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp));
      }

      const images: ImagePart[] = [];
      const lines: string[] = [];
      let size = 0;
      for (const m of messages) {
        const notes: string[] = [];
        const shown = await imagesOf(m.attachments, MAX_IMAGES - images.length, notes);
        for (const url of findUrls(m.content).filter(isShortLink)) {
          const target = await expandShortLink(url).catch(() => url);
          if (target !== url) notes.push(`${url} leads to ${target}`);
        }
        images.push(...shown);
        const files = [...m.attachments.values()].map((a) => ` [attached: ${a.name}${shown.some((s) => s.url === a.url) ? ', shown' : ''}]`).join('');
        const text = `[${toLocalShort(m.createdAt, timeZone)} · ${m.author.bot ? 'bot' : m.author.username}] ${m.content}${files}${notes.map((n) => ` [${n}]`).join('')}`;
        if (size + text.length > MAX_READ_CHARS) {
          lines.push(`[…stopped here to keep this short. Read on from ${m.url}]`);
          break;
        }
        size += text.length;
        lines.push(text);
      }
      const last = messages.at(-1);
      const more = link.messageId && messages.length >= count && last ? `\n[There may be more. Read on from ${last.url}]` : '';
      return { content: (lines.join('\n') || 'No messages there.') + more, images };
    },
  };
}
