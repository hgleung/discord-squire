import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Vault } from '../../vault.js';
import { calendarTools } from './calendarTools.js';
import { ALL_GROUPS } from './channelTools.js';
import { CASE_RUNNERS, type CaseRun, type Verdict } from './evals.js';
import { jobPrompt, jobSettings } from './factory.js';
import type { GoogleAccount } from './google.js';
import type { ToolCall, ToolDef, Turn, Usage } from './llm.js';
import { addUsage } from './usage.js';
import { notesTools } from './notes.js';
import { expenseTools, photoPrompt } from './photo.js';
import { placesTools } from './placesTools.js';
import type { SavedPlaces } from './places.js';
import { trainingTools } from './trainingTools.js';
import type { TrainingService } from '../training/service.js';

/**
 * Photo-action evals. Each case is an image beside its case note in
 * Factory/Evals/photo/. The image goes to the fast model with the photo
 * prompt under test and the real tool definitions; no tool is ever run. Read
 * tools (lists, today's session) get a stub answer so the model can go on to
 * act; the first action it takes is what's checked.
 */

/** Where the starter images live in the repo; they're copied into the vault with the cases. */
export const PHOTO_ASSETS = join(dirname(fileURLToPath(import.meta.url)), 'evalAssets', 'photo');

const ACTIONS = new Set(['calendar_create_event', 'log_expense', 'places_add', 'save_note', 'training_log_set', 'training_load_split']);
const MAX_STEPS = 4;

/** The tool definitions a photo can lead to, as the chat sees them. */
function photoToolDefs(vault: Vault, timeZone: string): ToolDef[] {
  const none = {} as never;
  return [
    ...calendarTools(none as GoogleAccount, timeZone, false),
    ...expenseTools(vault, timeZone),
    ...placesTools(none as SavedPlaces, timeZone),
    ...notesTools(vault, timeZone),
    ...trainingTools(none as TrainingService),
  ].map((h) => h.def);
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ');

/** Right action: the first action call is the expected tool ("none": it asks instead of acting). Details: every expected text is in that call's input. */
export function photoVerdicts(expectTool: string, expect: string[], calls: ToolCall[], reply: string): Record<string, Verdict> {
  const acted = calls.filter((c) => ACTIONS.has(c.name));
  const first = acted[0];
  if (expectTool === 'none') {
    return {
      'Right action': first ? { pass: false, why: `called ${first.name} instead of asking` } : { pass: true, why: `asked: ${reply.slice(0, 120)}` },
    };
  }
  const right: Verdict = first?.name === expectTool ? { pass: true, why: expectTool } : { pass: false, why: first ? `called ${first.name}, wanted ${expectTool}` : `took no action, wanted ${expectTool}` };
  const input = norm(acted.filter((c) => c.name === expectTool).map((c) => JSON.stringify(c.input)).join(' '));
  const missing = expect.filter((e) => !input.includes(norm(e)));
  return {
    'Right action': right,
    'Details read': !first ? { pass: false, why: 'no action taken' } : missing.length ? { pass: false, why: `missing ${missing.map((m) => `"${m}"`).join(', ')}` } : { pass: true, why: `has ${expect.join(', ')}` },
  };
}

CASE_RUNNERS.photo = async (c, o, llm): Promise<CaseRun> => {
  const folder = jobSettings(o.vault, 'photo').evals;
  const file = o.vault.abs(`${folder}/${c.input}`);
  if (!existsSync(file)) throw new Error(`No image at ${folder}/${c.input}.`);
  const mimeType = c.input.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
  const today = String(c.fields.today ?? '2026-11-20');
  const system = `You are Squire, the owner's assistant on Discord. Today is ${today}, owner's time zone ${o.timeZone}.${photoPrompt(ALL_GROUPS, jobPrompt(o.vault, 'photo', o.prompt).text)}`;
  const turns: Turn[] = [{ role: 'user', content: [{ type: 'image', url: `eval:${c.input}`, mimeType, data: readFileSync(file).toString('base64') }, ...(c.ask ? [{ type: 'text' as const, text: c.ask }] : [])] }];
  const tools = photoToolDefs(o.vault, o.timeZone);
  const calls: ToolCall[] = [];
  let reply = '';
  let usage: Usage | undefined;
  for (let step = 0; step < MAX_STEPS; step++) {
    const gen = await llm.generate({ model: o.judge.model, effort: 'low' }, { system, tools, turns, web: { maxUses: 0 } });
    if (gen.usage) usage = usage ? addUsage(usage, gen.usage) : gen.usage;
    reply = gen.text;
    calls.push(...gen.calls);
    if (!gen.calls.length || gen.calls.some((x) => ACTIONS.has(x.name))) break;
    turns.push(gen.turn);
    turns.push({ role: 'tool', results: gen.calls.map((x) => ({ callId: x.id, name: x.name, content: '(eval: nothing to show; go on as if this came back empty or as expected)' })) });
  }
  const verdicts = photoVerdicts(String(c.fields.expect_tool ?? ''), Array.isArray(c.fields.expect) ? c.fields.expect.map(String) : [], calls, reply);
  const note = calls.map((x) => `${x.name} ${JSON.stringify(x.input)}`).join('\n') + (reply ? `\n\nReply: ${reply}` : '');
  return { output: 'tools (not run)', note, report: reply, status: 'done', evidence: c.input, usage, verdicts };
};

type Seed = { name: string; fields: Record<string, unknown>; why: string };

/**
 * Starter photo cases: generated images of the kinds of photo the actions
 * cover, each aimed at a rule (read the venue's time, total includes tax and
 * tip, ask when the date can't be read). Real photos can be added beside them.
 */
export const PHOTO_CASES: Seed[] = [
  { name: 'Concert flyer', why: 'An event flyer goes on the calendar at doors time (the owner\'s preference), with the venue as the location.', fields: { input: 'Concert flyer.png', expect_tool: 'calendar_create_event', expect: ['neon harbor', '2027-01-09', '19:00', 'bayview hall'] } },
  { name: 'Coffee receipt', why: 'A receipt is logged at the total paid, tax and tip included, on the receipt\'s date.', fields: { input: 'Coffee receipt.png', expect_tool: 'log_expense', expect: ['fogline', '20.38', '2026-11-18'] } },
  { name: 'Ramen menu', why: 'A menu with an address is a place to save, not a note.', fields: { input: 'Ramen menu.png', expect_tool: 'places_add', expect: ['noodle lantern'] } },
  { name: 'Recipe card', why: 'A recipe card is transcribed into Recipes with its own measurements.', fields: { input: 'Recipe card.png', expect_tool: 'save_note', expect: ['recipes', 'banana bread', '1/3 cup'] } },
  { name: 'Gym whiteboard', why: 'Sets on a whiteboard are logged one call per set, at the weights shown.', fields: { input: 'Gym whiteboard.png', expect_tool: 'training_log_set', expect: ['squat', '225'] } },
  { name: 'Poster with no date', why: '"If the date or time can\'t be read, ask for just that instead of guessing": a weekly market with no date.', fields: { input: 'Market poster.png', expect_tool: 'none', expect: [] } },
];

/** Copies a photo case's image into the vault beside its note, if it isn't there. */
export function copyPhotoAsset(vault: Vault, name: string): void {
  const dest = vault.abs(`${jobSettings(vault, 'photo').evals}/${name}`);
  const src = join(PHOTO_ASSETS, name);
  if (existsSync(dest) || !existsSync(src)) return;
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
}
