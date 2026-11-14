import type { ToolHandler } from './llm.js';
import type { Repeat, ReminderStore } from './reminders.js';
import { toLocalIso, toLocalShort } from './time.js';

const REPEATS: Repeat[] = ['none', 'daily', 'weekdays', 'weekly', 'monthly'];

/** create/list/cancel reminder tools, bound to the channel they're used from. */
export function reminderTools(store: ReminderStore, timeZone: string, channelId: string, channelName: string): ToolHandler[] {
  return [
    {
      def: {
        name: 'create_reminder',
        description:
          'Schedule a reminder that will be posted in the current channel and ping the owner at the given time. ' +
          'Use for any "remind me", "don\'t let me forget", or "tell me at/in ..." request.',
        strict: true,
        input_schema: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'The message the owner should see when it fires.' },
            due: {
              type: 'string',
              description: 'When to fire, as ISO 8601 with the UTC offset, e.g. 2026-11-13T08:00:00-08:00.',
            },
            repeat: { type: 'string', enum: REPEATS, description: 'How it recurs after the first time. "none" for a one-off.' },
          },
          required: ['text', 'due', 'repeat'],
          additionalProperties: false,
        },
      },
      run(args) {
        const now = new Date();
        const text = typeof args.text === 'string' ? args.text.trim() : '';
        const due = new Date(String(args.due));
        const repeat = REPEATS.includes(args.repeat as Repeat) ? (args.repeat as Repeat) : 'none';
        if (!text) throw new Error('Reminder text is empty.');
        if (Number.isNaN(due.getTime())) throw new Error(`Could not read "${args.due}" as a date and time.`);
        if (due.getTime() < now.getTime() - 60_000) {
          throw new Error(`${toLocalIso(due, timeZone)} is in the past (it is now ${toLocalIso(now, timeZone)}).`);
        }
        const r = store.add({ text, due, repeat, channelId }, now);
        return `Created reminder ${r.id} for ${toLocalShort(due, timeZone)} (${toLocalIso(due, timeZone)}), repeat: ${repeat}, in #${channelName}.`;
      },
    },
    {
      def: {
        name: 'list_reminders',
        description: 'List every pending reminder with its id, next time, repeat, and channel.',
        strict: true,
        input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
      },
      run() {
        const all = store.list();
        if (all.length === 0) return 'No pending reminders.';
        return all
          .map((r) => `${r.id} · ${toLocalShort(new Date(r.due), timeZone)} · repeat: ${r.repeat} · <#${r.channelId}> · ${r.text}`)
          .join('\n');
      },
    },
    {
      def: {
        name: 'cancel_reminder',
        description: 'Cancel a pending reminder by its id (from list_reminders or from when it was created).',
        strict: true,
        input_schema: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
          additionalProperties: false,
        },
      },
      run(args) {
        const r = store.cancel(String(args.id ?? ''));
        if (!r) throw new Error(`No pending reminder with id "${args.id}".`);
        return `Cancelled ${r.id}: ${r.text}`;
      },
    },
  ];
}
