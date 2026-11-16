import type { ActivityEvent } from './activity.js';
import type { JournalEntry } from './journal.js';
import { dollars } from './usage.js';
import { toLocalIso, toLocalShort } from './time.js';

/**
 * Reading the activity log back: /usage's spending summary, and the digest
 * the daily review reads (journal plus activity, without repeating either).
 */

const cost = (events: ActivityEvent[]) => events.reduce((sum, e) => sum + (e.costUsd ?? 0), 0);
const KIND_LABEL: Record<string, string> = { reply: 'chat replies', task: 'background tasks', journal: 'journal summaries', brief: 'morning briefs', update: 'updates' };

/** /usage: spending by day, by kind, and the priciest jobs. */
export function usageSummary(events: ActivityEvent[], timeZone: string, days: number): string {
  if (events.length === 0) return `Nothing logged in the last ${days} day${days === 1 ? '' : 's'}.`;
  const total = cost(events);
  const lines = [`**API spend, last ${days} day${days === 1 ? '' : 's'}: ${dollars(total)}** (estimated from list prices)`];

  const byDay = new Map<string, ActivityEvent[]>();
  for (const e of events) {
    const day = toLocalIso(new Date(e.at), timeZone).slice(0, 10);
    byDay.set(day, [...(byDay.get(day) ?? []), e]);
  }
  lines.push(
    [...byDay]
      .sort(([a], [b]) => b.localeCompare(a))
      .map(([day, es]) => `${day}: ${dollars(cost(es))} · ${es.filter((e) => e.kind === 'reply').length} replies`)
      .join('\n'),
  );

  const byKind = new Map<string, ActivityEvent[]>();
  for (const e of events) byKind.set(e.kind, [...(byKind.get(e.kind) ?? []), e]);
  lines.push(
    [...byKind]
      .sort(([, a], [, b]) => cost(b) - cost(a))
      .map(([kind, es]) => `${KIND_LABEL[kind] ?? kind}: ${dollars(cost(es))} (${es.length})`)
      .join(' · '),
  );

  const top = events.filter((e) => (e.costUsd ?? 0) > 0).sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0)).slice(0, 5);
  if (top.length) {
    lines.push(
      `Priciest:\n${top
        .map((e) => `- ${dollars(e.costUsd ?? 0)} ${e.kind === 'task' ? `task "${e.title}"` : e.kind === 'reply' ? `reply in #${e.channel}: "${clip(e.ask ?? '', 60)}"` : (KIND_LABEL[e.kind] ?? e.kind)} · ${toLocalShort(new Date(e.at), timeZone)}`)
        .join('\n')}`,
    );
  }
  const searches = events.reduce((n, e) => n + (e.usage?.webSearches ?? 0), 0);
  if (searches) lines.push(`-# ${searches} web searches ($10 per 1,000) are included.`);
  return lines.join('\n\n');
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * What the daily review reads: the journal for what each conversation was
 * about and decided, then the activity log for each message's mechanics.
 * Problems come first so they aren't lost in a long day.
 */
export function reviewDigest(entries: JournalEntry[], events: ActivityEvent[], timeZone: string, since: Date): string {
  const out: string[] = [];
  const t = (iso: string) => toLocalShort(new Date(iso), timeZone);

  const journal = entries.filter((e) => e.to >= since.toISOString());
  out.push(`===== Journal: ${journal.length} conversation(s) since ${t(since.toISOString())} =====`);
  out.push(journal.length ? journal.map((e) => `- ${t(e.from)} → ${t(e.to)} #${e.channelName}${e.ongoing ? ` (ongoing until ${e.ongoing.until})` : ''}\n  ${e.summary.replace(/\s*\n\s*/g, ' ')}`).join('\n') : '(none summarised yet; a conversation is summarised 30 minutes after it goes quiet)');

  const problems = events.filter((e) => e.outcome !== 'ok' || (e.tools ?? []).some((x) => x.includes(': ')));
  out.push(`\n===== Problems: ${problems.length} =====`);
  out.push(
    problems.length
      ? problems
          .map((e) => {
            const failed = (e.tools ?? []).filter((x) => x.includes(': '));
            const what = e.kind === 'reply' ? `reply to "${clip(e.ask ?? '', 120)}"` : e.kind === 'task' ? `task "${e.title}"` : e.kind;
            return `- ${t(e.at)} #${e.channel ?? '-'} ${what} → ${e.outcome}${e.error ? `: ${e.error}` : ''}${failed.length ? `\n  failed tools: ${failed.join(' | ')}` : ''}${e.messageId ? `\n  message ${e.messageId}` : ''}`;
          })
          .join('\n')
      : '(none)',
  );

  const replies = events.filter((e) => e.kind === 'reply');
  out.push(`\n===== Asks, in order: ${replies.length} =====`);
  const byChannel = new Map<string, ActivityEvent[]>();
  for (const e of replies) byChannel.set(e.channel ?? '-', [...(byChannel.get(e.channel ?? '-') ?? []), e]);
  for (const [channel, es] of byChannel) {
    out.push(`#${channel}`);
    for (const e of es) {
      const tools = summarizeTools(e.tools ?? []);
      out.push(`- ${t(e.at)}${e.voice ? ' 🎤' : ''} "${clip(e.ask ?? '', 200)}" → ${e.outcome}, ${Math.round((e.ms ?? 0) / 1000)}s${tools ? `, ${tools}` : ''}${e.usage?.webSearches ? `, ${e.usage.webSearches} searches` : ''}`);
    }
  }

  const others = events.filter((e) => e.kind !== 'reply');
  if (others.length) {
    out.push(`\n===== Other activity =====`);
    out.push(others.map((e) => `- ${t(e.at)} ${e.kind}${e.title ? ` "${e.title}"` : ''} → ${e.outcome}${e.calls ? `, ${e.calls} calls` : ''}${e.costUsd ? `, ${dollars(e.costUsd)}` : ''}`).join('\n'));
  }
  out.push(`\nEstimated API spend in this window: ${dollars(cost(events))}`);
  return out.join('\n');
}

/** "web_fetch, calendar_events ×2" from a list of tool calls. */
function summarizeTools(tools: string[]): string {
  const counts = new Map<string, number>();
  for (const x of tools) {
    const name = x.split(':')[0]!;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts].map(([n, c]) => (c > 1 ? `${n} ×${c}` : n)).join(', ');
}
