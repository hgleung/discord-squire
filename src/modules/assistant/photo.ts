import type { ToolHandler } from './llm.js';
import type { Vault } from '../../vault.js';
import { writeIfChanged } from '../../vault.js';
import type { ToolGroup } from './channelTools.js';
import { toLocalIso } from './time.js';

/**
 * Photo to action: a photo or screenshot sent with no ask (or with "add
 * this") becomes the thing it's for. Each action names the tool group it
 * needs, so a channel without that group isn't told about it. To teach Squire
 * a new kind of photo, add a row here (and a tool, if it needs one).
 */
export interface PhotoAction {
  /** What the photo shows. */
  when: string;
  /** What to do with it. */
  then: string;
  /** The tool group it needs; actions without one work everywhere. */
  needs?: ToolGroup;
}

export const PHOTO_ACTIONS: PhotoAction[] = [
  {
    when: 'an event: a flyer, poster, ticket, invite, booking confirmation, or a screenshot of plans in a chat',
    then: 'add it to the calendar with calendar_create_event (title, date, start and end, the venue address as the location, in the venue\'s time zone), then confirm in one line with the day and time. If the date or time can\'t be read, ask for just that instead of guessing.',
    needs: 'google',
  },
  {
    when: 'a receipt or bill',
    then: 'log it with log_expense (merchant, the total paid including tax and tip, the date on the receipt, a category), then confirm with the amount and merchant.',
    needs: 'expenses',
  },
  {
    when: 'a place: a storefront, a menu, a Maps or Yelp screenshot, or a restaurant post',
    then: 'save it with places_add to the list that fits, as you would a shared link.',
    needs: 'places',
  },
  {
    when: 'a recipe: a cookbook page, a recipe card, or a screenshot of one',
    then: 'transcribe it into a recipe note with save_note in Recipes, with "owner" as its source, keeping its own measurements.',
    needs: 'notes',
  },
  {
    when: 'a workout: a gym whiteboard, a program, or a screenshot of sets',
    then: 'log the sets it shows with the training_ tools, or read the program out if nothing was done yet.',
    needs: 'training',
  },
  {
    when: 'handwriting, a whiteboard, or a page of notes',
    then: 'transcribe it into a note with save_note (Squire/Inbox unless the topic has a home), and say where it went.',
    needs: 'notes',
  },
];

/**
 * The photo job's prompt as a note holds one action per line,
 * "- (tool group) what the photo shows => what to do", so the actions can be
 * versioned in Factory/Prompts/photo vN.md and still be filtered by channel.
 */
export const PHOTO_JOB_PROMPT = PHOTO_ACTIONS.map((a) => `- ${a.needs ? `(${a.needs}) ` : ''}${a.when} => ${a.then}`).join('\n');

/** The actions in a photo prompt note; lines that don't fit the shape are skipped. */
export function parsePhotoActions(text: string): PhotoAction[] {
  return text
    .split('\n')
    .map((l) => /^-\s+(?:\((\w+)\)\s+)?(.+?)\s+=>\s+(.+)$/.exec(l.trim()))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ when: m[2]!, then: m[3]!, ...(m[1] ? { needs: m[1] as ToolGroup } : {}) }));
}

/** The prompt section for photos, listing only the actions this channel can take. A prompt note's actions replace the built-in ones. */
export function photoPrompt(groups: ReadonlySet<ToolGroup>, promptText?: string): string {
  const parsed = promptText ? parsePhotoActions(promptText) : [];
  const actions = (parsed.length ? parsed : PHOTO_ACTIONS).filter((a) => !a.needs || groups.has(a.needs));
  if (actions.length === 0) return '';
  return `
Photos:
- When they send a photo or screenshot with no ask, or with "add this", "save this" or "log this", work out what it's for and do it in this reply:
${actions.map((a) => `  - ${a.when}: ${a.then}`).join('\n')}
- Read every detail from the image itself (names, dates, amounts, addresses); never fill one in. If the photo fits none of these, or it's unclear which, say in a few words what you see and ask what they want done. If they ask a question about the photo, just answer it.`;
}

/** Where expenses go in the vault: one note per month, at the root with the owner's other notes. */
export const EXPENSES_FOLDER = 'Finance/Expenses';

const HEADER = '| Date | Merchant | Amount | Category | Note |\n|---|---|---|---|---|';
const cell = (s: string) => s.replace(/\|/g, '/').replace(/\s+/g, ' ').trim();

/** Adds one expense row to the month's note, creating it with a header the first time. Returns the note's path. */
export function appendExpense(
  vault: Vault,
  e: { date: string; merchant: string; amount: number; currency: string; category: string; note: string },
): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(e.date)) throw new Error('date must be YYYY-MM-DD.');
  if (!Number.isFinite(e.amount) || e.amount <= 0) throw new Error('amount must be a positive number.');
  if (!e.merchant.trim()) throw new Error('Give the merchant.');
  const path = `${EXPENSES_FOLDER}/${e.date.slice(0, 7)}.md`;
  const existing = vault.read(path);
  const symbol = e.currency.toUpperCase() === 'USD' || !e.currency ? '$' : `${e.currency.toUpperCase()} `;
  const row = `| ${e.date} | ${cell(e.merchant)} | ${symbol}${e.amount.toFixed(2)} | ${cell(e.category)} | ${cell(e.note)} |`;
  const body = existing?.includes(HEADER)
    ? `${existing.replace(/\s+$/, '')}\n${row}\n`
    : `${existing ? `${existing.replace(/\s+$/, '')}\n\n` : `# Expenses ${e.date.slice(0, 7)}\n\n`}${HEADER}\n${row}\n`;
  writeIfChanged(vault.abs(path), body);
  return path;
}

export function expenseTools(vault: Vault, timeZone: string, clock: () => Date = () => new Date()): ToolHandler[] {
  return [
    {
      def: {
        name: 'log_expense',
        description: `Log one expense (from a receipt photo, or when the owner says what they spent) as a row in the month's expense note, ${EXPENSES_FOLDER}/YYYY-MM.md.`,
        strict: true,
        input_schema: {
          type: 'object',
          properties: {
            date: { type: 'string', description: 'YYYY-MM-DD: the receipt\'s date, or today.' },
            merchant: { type: 'string', description: 'Where it was spent.' },
            amount: { type: 'number', description: 'The total paid, tax and tip included.' },
            currency: { type: 'string', description: 'ISO code, USD unless the receipt says otherwise.' },
            category: { type: 'string', description: 'One or two words: groceries, dining, travel, transport, shopping, bills, health, fun, other.' },
            note: { type: 'string', description: 'Anything worth keeping (what it was for, who split it); empty string if nothing.' },
          },
          required: ['date', 'merchant', 'amount', 'currency', 'category', 'note'],
          additionalProperties: false,
        },
      },
      run(args) {
        const date = String(args.date || toLocalIso(clock(), timeZone).slice(0, 10));
        const path = appendExpense(vault, {
          date,
          merchant: String(args.merchant ?? ''),
          amount: Number(args.amount),
          currency: String(args.currency || 'USD'),
          category: String(args.category || 'other'),
          note: String(args.note ?? ''),
        });
        return `Logged in ${path}.`;
      },
    },
  ];
}
