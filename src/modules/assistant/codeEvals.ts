import { stringify } from 'yaml';
import type { Vault } from '../../vault.js';
import { writeBrief } from './brief.js';
import { CASE_RUNNERS, loadCases, RECIPE_CASES, seedRecipeCases, type CaseRun, type EvalCase, type Verdict } from './evals.js';
import { jobPrompt, jobSettings } from './factory.js';
import { inEventZone, parseInboxCancellations, parseInboxEvents } from './inboxEvents.js';
import { copyPhotoAsset, PHOTO_CASES } from './photoEvals.js';
import { TRAINING_CASES } from './trainingEvals.js';
import { parseProposals } from './vaultHealth.js';

/**
 * Eval cases and case runners for the jobs beyond recipes. Code-run jobs
 * (inbox events, the brief) run their one model call on the case's input
 * with the prompt under test; nothing touches Gmail, the calendar or Discord.
 * The research job runs as a real task, like recipes.
 */

const words = (s: string) => new Set((s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length >= 3));
const shares = (a: string, b: string) => [...words(a)].some((w) => words(b).has(w));

/** Expected entries are "title words @ YYYY-MM-DD[THH:MM]"; a found one matches on a shared word and the same start. */
export function eventsVerdict(expected: string[], found: { title: string; start: string }[], label: string): Verdict {
  const want = expected.map((e) => {
    const [title, start = ''] = e.split('@').map((x) => x.trim());
    return { title: title!, start };
  });
  const missing = want.filter((w) => !found.some((f) => shares(w.title, f.title) && (!w.start || f.start.startsWith(w.start))));
  const extra = found.filter((f) => !want.some((w) => shares(w.title, f.title) && (!w.start || f.start.startsWith(w.start))));
  if (!missing.length && !extra.length) return { pass: true, why: want.length ? `found ${want.map((w) => w.title).join(', ')}` : `no ${label}, as expected` };
  return {
    pass: false,
    why: [missing.length ? `missed ${missing.map((m) => `${m.title} @ ${m.start}`).join(', ')}` : '', extra.length ? `wrongly found ${extra.map((x) => `${x.title} @ ${x.start}`).join(', ')}` : ''].filter(Boolean).join('; '),
  };
}

const asList = (v: unknown) => (Array.isArray(v) ? v.map(String) : v ? [String(v)] : []);

/** Inbox events: the case's emails go through the job's prompt; code checks events and cancellations against what's expected. */
CASE_RUNNERS['inbox-calendar'] = async (c, o, llm): Promise<CaseRun> => {
  const today = String(c.fields.today ?? '2026-11-20');
  const zone = o.timeZone;
  const gen = await llm.generate(
    { model: o.judge.model, effort: 'low' },
    {
      system: jobPrompt(o.vault, 'inbox-calendar', o.prompt).text,
      tools: [],
      turns: [{ role: 'user', content: [{ type: 'text', text: `Today is ${today} (${zone}).\n\nEmails (untrusted):\n${c.input}` }] }],
      web: { maxUses: 0 },
    },
  );
  const events = parseInboxEvents(gen.text).map((e) => inEventZone(e, e.time_zone || zone));
  const cancelled = parseInboxCancellations(gen.text);
  const verdicts: Record<string, Verdict> = {
    'Events right': eventsVerdict(asList(c.fields.expect_events), events, 'events'),
    'Cancellations right': eventsVerdict(asList(c.fields.expect_cancelled), cancelled.map((x) => ({ title: x.title, start: x.date })), 'cancellations'),
  };
  const note = JSON.stringify({ events, cancelled }, null, 2);
  return { output: 'calendar (not written)', note, report: gen.text, status: 'done', evidence: c.input, usage: gen.usage, verdicts };
};

/** The brief: the case's facts are worded by the prompt under test; code checks the shape, the model the checklist. */
CASE_RUNNERS.brief = async (c, o, llm): Promise<CaseRun> => {
  const { text, usage } = await writeBrief(llm, { model: o.judge.model, effort: 'low' }, c.input, undefined, [], String(c.fields.rules ?? ''), { system: jobPrompt(o.vault, 'brief', o.prompt).text });
  const tooLong = text.length > 1600;
  const headings = /^#{1,6}\s|^\|.*\|$/m.test(text);
  const vague = /\b(TBD|not set|no time set|unknown|to be decided)\b/i.exec(text);
  const verdicts: Record<string, Verdict> = {
    'Discord shape': tooLong || headings ? { pass: false, why: tooLong ? `${text.length} characters, over the limit` : 'has # headings or a table' } : { pass: true, why: `${text.length} characters, bullets only` },
    'No missing-detail talk': vague ? { pass: false, why: `says "${vague[0]}"` } : { pass: true, why: 'never says a detail is missing' },
  };
  return { output: 'Discord (not posted)', note: text, report: '', status: 'done', evidence: c.input, usage, verdicts };
};

/**
 * Vault health: the case's candidate list goes through the prompt under test.
 * Code checks the expected proposals ("archive notes/Old.md", "file Squire/Inbox/X.md -> Recipes/Soup")
 * and that nothing in forbid is proposed; the model judges the checklist.
 */
CASE_RUNNERS['vault-health'] = async (c, o, llm): Promise<CaseRun> => {
  const gen = await llm.generate(
    { model: o.judge.model, effort: 'low' },
    {
      system: jobPrompt(o.vault, 'vault-health', o.prompt).text,
      tools: [],
      turns: [{ role: 'user', content: [{ type: 'text', text: `Today is ${String(c.fields.today ?? '2026-11-22')}.\n\nCandidates:\n${c.input}` }] }],
      web: { maxUses: 0 },
    },
  );
  const found = parseProposals(gen.text);
  const has = (want: string) => {
    const [action, rest = ''] = want.split(/\s+(.*)/s);
    const [path, target] = rest.split('->').map((x) => x.trim());
    return found.some((f) => f.action === action && f.paths.includes(path!) && (!target || f.target?.replace(/\/+$/, '') === target.replace(/\/+$/, '')));
  };
  const missing = asList(c.fields.expect).filter((e) => !has(e));
  const forbidden = asList(c.fields.forbid).filter((p) => found.some((f) => f.paths.includes(p)));
  const verdicts: Record<string, Verdict> = {
    'Expected proposals': missing.length ? { pass: false, why: `missed ${missing.join(', ')}` } : { pass: true, why: `${found.length} proposal(s), all expected ones there` },
    'Leaves the rest alone': forbidden.length ? { pass: false, why: `proposed touching ${forbidden.join(', ')}` } : { pass: true, why: 'nothing it should leave was touched' },
  };
  return { output: 'Squire/Health (not written)', note: gen.text, report: '', status: 'done', evidence: c.input, usage: gen.usage, verdicts };
};

/**
 * Vault-health cases, shaped like a typical vault (Cafes, proj-ideas, Travel/<trip>, Squire/Inbox).
 * Generic examples: they test the rules, not a past failure.
 */
const HEALTH_CASES: Seed[] = [
  { name: 'Stale stub', why: 'An empty, old, unlinked idea should be archived.', fields: { input: 'proj-ideas/Untitled 3.md · modified 2025-02-01 · 14 chars · no type · linked from 0 · untouched 659 days, nothing links to it; almost empty', expect: ['archive proj-ideas/Untitled 3.md'], checklist: ['It proposes archiving the stub.', 'It proposes nothing else.'] } },
  { name: 'Recipe in the inbox', why: 'A recipe left in Squire/Inbox should be filed in its Recipes subfolder.', fields: { input: 'Squire/Inbox/Tomato soup notes.md · modified 2026-11-01 · 900 chars · no type · linked from 0 · not filed', expect: ['file Squire/Inbox/Tomato soup notes.md -> Recipes/Soup'], forbid: [], checklist: ['It files the soup in Recipes/Soup.', 'It does not archive it.'] } },
  { name: 'Linked old note', why: 'Old but linked notes are still in use and must be left.', fields: { input: 'Cafes/Corner Cafe.md · modified 2025-03-10 · 400 chars · type place · linked from 3 · looks like a version or draft', forbid: ['Cafes/Corner Cafe.md'], checklist: ['It proposes nothing for Corner Cafe, or only an update with a clear reason.'] } },
  { name: 'Two versions', why: 'A v2 next to the original is a merge, keeping the newer.', fields: { input: 'Travel/Lisbon/Itinerary.md · modified 2026-10-01 · 2000 chars · no type · linked from 1 · another note has the same name\nTravel/Lisbon/Itinerary v2.md · modified 2026-11-12 · 3500 chars · no type · linked from 0 · looks like a version or draft', expect: ['merge Travel/Lisbon/Itinerary.md -> Travel/Lisbon/Itinerary v2.md'], checklist: ['It proposes merging the two itinerary notes, keeping Itinerary v2.', 'It does not archive either one outright.'] } },
  { name: 'Nothing to do', why: 'Filed, linked notes need no proposals; the job should say none.', fields: { input: 'Recipes/Meal/Fried Rice.md · modified 2026-11-10 · 110 chars · no type · linked from 2 · almost empty', forbid: ['Recipes/Meal/Fried Rice.md'], checklist: ['It answers none, or proposes nothing destructive for the recipe.'] } },
];

type Seed = { name: string; fields: Record<string, unknown>; why: string };

/** The research cases: generic examples of the kinds of research tasks the job gets, each aimed at a research rule. */
const RESEARCH_CASES: Seed[] = [
  {
    name: 'Trip itinerary',
    why: 'A multi-city trip plan with flights already booked.',
    fields: {
      input: 'Owner is a first-time visitor to Portugal. Arrive Lisbon (LIS) May 4 2027 ~09:30 on TAP TP200; return May 12 2027 on TAP TP201 LIS 11:00. Draft an 8-night itinerary May 4-12 2027 in Lisbon plus a Porto stint (by train), with English-friendly food and sights, and transit tips. Keep it to a concise day-by-day outline.',
      checklist: ['Every day from May 4 to May 12 is covered, with the Porto stint reached by train.', 'Any seasonal claim (weather, festivals) is given with a source or marked unverified.', 'The booked flights are kept as they are.', 'It reads as a short day-by-day outline with no tables.'],
    },
  },
  {
    name: 'Compare three services',
    why: '"Verify each, don\'t trust marketing claims alone."',
    fields: {
      input: 'Find 3 English-friendly cooking classes in Lisbon, noting whether they teach in English, how to book from abroad, group size, and prices if listed. Include links.',
      checklist: ['Three classes, each with its own link.', 'English teaching and booking from abroad are stated per class with where it was confirmed, or marked unverified.', 'No price is stated as fact without a source.'],
    },
  },
  {
    name: 'Booking a small business',
    why: 'A business known only by its social page, which may not open.',
    fields: {
      input: 'Find out how to book a portrait photo session with a small Lisbon studio known only by its Instagram handle (https://www.instagram.com/example.studio) for May 5-11, 2027: English availability, booking method, price range, and whether it takes foreign clients booking from abroad. If not verifiable, say so and list English-language alternatives on booking sites.',
      checklist: ['It says plainly whether the booking details were verified, and from where.', 'Nothing about the studio is stated as fact without a source it opened.', 'If unverified, it lists English-language alternatives with links.'],
    },
  },
  {
    name: 'Return routing',
    why: '"Do not claim a live fare unless you verified it."',
    fields: {
      input: 'The current return is TAP TP201 LIS on May 12 2027 at 11:00. Compare keeping it versus routing Lisbon to Madrid (MAD) for a few nights, then flying home from Madrid: realistic price ranges, the ticket-change implications for the TAP ticket, and Spain entry rules for US citizens.',
      checklist: ['No fare is given as a live price unless it was seen on a page this run; ranges say where they came from.', 'The change implications for the existing ticket are covered or marked unverified.', 'Entry rules for US citizens come with a source.', 'It ends with a clear recommendation or the open question.'],
    },
  },
  {
    name: 'Stays to book',
    why: 'A booking list with constraints and one stay already booked.',
    fields: {
      input: 'Still to book for a solo traveler, budget-moderate, English-friendly: Porto, Ribeira area, May 8-10 2027, and Lisbon Baixa, May 10-12 (near a metro station for the airport). Already booked, don\'t change: Sample Guesthouse, Alfama, May 4-8. Give a booking list with links.',
      checklist: ['Each stay has a link and whether its price or availability was verified.', 'The existing Alfama booking is left as it is.', 'Every stay fits the stated constraints.'],
    },
  },
  {
    name: 'Recipe amounts',
    why: 'A video gives no amounts, so every amount needs a source or an estimate label.',
    fields: {
      input: 'Find a reliable recipe with measurements for Spanish tortilla, the style of a short cooking video that gives no amounts. Find 1-2 published recipes for the egg and potato mixture and the oil, and suggest one set of amounts for 1 to 2 servings. Note which amounts come from which source and which are your own estimate. Save nothing.',
      checklist: ['Every amount has a source link or is labeled an estimate.', 'Nothing was saved to the vault.', 'It flags what it could not verify.'],
    },
  },
];

/**
 * The inbox cases: generic emails, each aimed at a kind of inbox mistake
 * (raffles, presale codes, pickup orders, transferred tickets, UTC times).
 */
const INBOX_CASES: Seed[] = [
  { name: 'Club ticket', why: 'A ticket order should go on the calendar at doors time.', fields: { today: '2026-11-20', input: '[1] Subject: Your order: DJ Nova at Skyline Club\nThanks for your order! DJ Nova — Skyline Club, Chicago. Saturday, December 12, 2026. Doors 10:00 PM. 2 x General Admission. Order #A1.', expect_events: ['DJ Nova @ 2026-12-12T22:00'], expect_cancelled: [] } },
  { name: 'Raffle entry', why: 'A raffle confirmation is not an event.', fields: { today: '2026-11-18', input: '[1] Subject: Your entry is confirmed\nYou\'re entered in the raffle for the sneaker launch. The draw closes Saturday at 9 AM; winners are emailed by Monday.', expect_events: [], expect_cancelled: [] } },
  { name: 'Presale code and pickup', why: 'Presale access and a food pickup order are not events.', fields: { today: '2026-11-19', input: '[1] Subject: Your presale code for the 2027 tour\nUse code SUNSET27 for presale access, Nov 21-23. Tour dates run April through June 2027.\n\n[2] Subject: Your order will be ready for pickup\nYour burrito order will be ready for pickup at 6:15 PM today at 100 Main St.', expect_events: [], expect_cancelled: [] } },
  { name: 'Ticket transferred away', why: 'A ticket the owner sent to a friend should come off the calendar.', fields: { today: '2026-11-17', input: '[1] Subject: Transfer Accepted\nYou transferred 1 ticket for Spring Esports Showdown (Dec 5, 2026, 7:00 PM, Ontario, CA) to Taylor. Taylor has accepted the transfer.', expect_events: [], expect_cancelled: ['Esports Showdown @ 2026-12-05'] } },
  { name: 'Times in UTC', why: 'An event listed in UTC must be converted, not put on the calendar 8 hours off.', fields: { today: '2026-11-15', input: '[1] Subject: Registration confirmed: Hack Night\nYou\'re registered for Hack Night at Moscone Center, San Francisco. Wednesday Nov 18, 2026, 3:00 AM UTC – 6:00 AM UTC.', expect_events: ['Hack Night @ 2026-11-17T19:00'], expect_cancelled: [] } },
  { name: 'Coming-up reminder', why: '"Your event is coming up" reminders repeat orders that may have been refunded.', fields: { today: '2026-11-19', input: '[1] Subject: Your event is coming up!\nDon\'t forget: The Midnight Owls at Riverside Hall, Friday Nov 27. Get ready!', expect_events: [], expect_cancelled: [] } },
  { name: 'Rescheduled show', why: 'The prompt says to cancel the old date and add the new one.', fields: { today: '2026-11-10', input: '[1] Subject: Date change for your tickets\nThe Odesza show at Chase Center on Nov 21, 2026 has been rescheduled to Saturday, January 9, 2027 at 8:00 PM. Your tickets are valid for the new date.', expect_events: ['Odesza @ 2027-01-09T20:00'], expect_cancelled: ['Odesza @ 2026-11-21'] } },
];

/** The brief cases: generic days, each aimed at a wording rule. */
const BRIEF_CASES: Seed[] = [
  { name: 'Quiet day', why: 'A day with nothing on should be one line.', fields: { input: 'Today is Friday, November 20.\nHome: Springfield, Oregon.\nCalendar today: nothing.\nReminders today: none.\nGmail was checked: nothing new from a person.', checklist: ['It says in one line that nothing is on.', 'It invents no events or advice.'] } },
  { name: 'Payment due date', why: 'A due date must come from the email body, not the day it arrived.', fields: { input: 'Today is Monday, November 16.\nCalendar today:\n- 3:30 PM: Dentist @ 1500 S Main St\nEmails from the last day:\n- From City Power (arrived Nov 16): "Your bill of $84.20 is due on November 30. This account is not on autopay."', checklist: ['The dentist is under Today with its time.', 'The power bill says due Nov 30, not today.'] } },
  { name: 'Tickets from yesterday', why: 'Open items need a due date, and background work stays out.', fields: { input: 'Today is Thursday, November 19.\nCalendar today:\n- 7:00 PM: Climbing with Chris\nThe owner said in a conversation yesterday they would book the Porto guesthouse by Friday Nov 20.\nA background task is researching Lisbon cooking classes.', checklist: ['The Porto booking is under Still open, due Friday.', 'Nothing mentions background tasks.'] } },
  { name: 'Missing details', why: 'Briefs must not say "no time set" or guess details; the strict rule forbids both.', fields: { input: 'Today is Tuesday, November 17.\nCalendar today:\n- all day: Mom\'s birthday\n- Pick up dry cleaning (no time)\nReminders today:\n- Call the bank about the card', checklist: ['Each item appears with only the details it has.', 'Nothing guesses a time or detail that isn\'t given.'] } },
  { name: 'Events added from the inbox', why: 'Added events must be said once under Inbox, not listed again as to-dos.', fields: { input: 'Today is Saturday, November 21.\nCalendar today: nothing.\nAdded to the owner\'s calendar just now from emails in the inbox (say so under **Inbox**, one line each, "Added to your calendar: ..."; don\'t also list those emails as needing action):\n- DJ Nova at Skyline, Sat, Dec 12, 10:00 PM @ Skyline Club, Chicago\nEmails from the last day:\n- From Skyline Club: "Your order: DJ Nova at Skyline Club"', checklist: ['Under Inbox it says DJ Nova was added to the calendar.', 'The Skyline Club email is not listed again as something to act on.'] } },
];

const SEEDS: Record<string, Seed[]> = { research: RESEARCH_CASES, 'inbox-calendar': INBOX_CASES, brief: BRIEF_CASES, 'vault-health': HEALTH_CASES, photo: PHOTO_CASES, 'training-log': TRAINING_CASES };

/** Writes a job's starter cases when its eval folder has none. Never overwrites. Returns what it wrote. */
export function seedCases(vault: Vault, job: string): string[] {
  if (job === 'recipe') return seedRecipeCases(vault);
  const seeds = SEEDS[job];
  if (!seeds || loadCases(vault, job).length) return [];
  const folder = jobSettings(vault, job).evals;
  return seeds
    .map((c) => {
      const path = `${folder}/${c.name}.md`;
      if (vault.read(path) !== undefined) return '';
      if (job === 'photo') copyPhotoAsset(vault, String(c.fields.input));
      vault.write(path, `---\n${stringify({ job, ...c.fields, tags: ['squire-eval-case'] }).trimEnd()}\n---\n\n# ${c.name}\n\n${c.why}\n`);
      return path;
    })
    .filter(Boolean);
}

/** How many starter cases each job has, for the checks. */
export const SEED_COUNTS: Record<string, number> = { recipe: RECIPE_CASES.length, ...Object.fromEntries(Object.entries(SEEDS).map(([k, v]) => [k, v.length])) };

export type { EvalCase };
