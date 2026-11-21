/**
 * Which tool groups a channel gets. Channels under the owner's chosen Discord
 * category (ASSISTANT_TOOL_CATEGORY, "squire" by default) get only the groups
 * their name calls for, so #gym isn't handed Gmail and Maps and the tool list
 * stays well under the API's strict-schema limits. Every other channel, and
 * any channel whose name isn't mapped, gets everything.
 *
 * Reminders, memory, the journal, background tasks, reading links, the brief's
 * own tools and web search are always on: they're useful anywhere.
 */

export const TOOL_GROUPS = ['notes', 'training', 'google', 'places', 'video', 'expenses'] as const;
export type ToolGroup = (typeof TOOL_GROUPS)[number];

export const ALL_GROUPS: ReadonlySet<ToolGroup> = new Set(TOOL_GROUPS);

/** Channel name → groups, for channels in the category. Names not listed get everything. */
export const DEFAULT_CHANNEL_TOOLS: Record<string, ToolGroup[]> = {
  gym: ['training', 'notes', 'video'],
  fitness: ['training', 'notes', 'video'],
  training: ['training', 'notes', 'video'],
  travel: ['google', 'places', 'notes', 'video', 'expenses'],
  trips: ['google', 'places', 'notes', 'video', 'expenses'],
  recipes: ['notes', 'video', 'places'],
  food: ['notes', 'video', 'places'],
  cooking: ['notes', 'video', 'places'],
};

/**
 * Parses ASSISTANT_CHANNEL_TOOLS: "gym=training,notes; travel=google,places".
 * A channel set to "all" gets everything. Throws naming an unknown group.
 */
export function parseChannelTools(value: string | undefined): Record<string, ToolGroup[] | 'all'> {
  const out: Record<string, ToolGroup[] | 'all'> = {};
  for (const pair of (value ?? '').split(';').map((p) => p.trim()).filter(Boolean)) {
    const [name, list = ''] = pair.split('=').map((s) => s.trim());
    if (!name) continue;
    const groups = list.toLowerCase().split(/[\s,]+/).filter(Boolean);
    if (groups.includes('all')) {
      out[name.toLowerCase().replace(/^#/, '')] = 'all';
      continue;
    }
    const bad = groups.find((g) => !(TOOL_GROUPS as readonly string[]).includes(g));
    if (bad) throw new Error(`ASSISTANT_CHANNEL_TOOLS: "${bad}" isn't a tool group. Groups: ${TOOL_GROUPS.join(', ')}, or all.`);
    out[name.toLowerCase().replace(/^#/, '')] = groups as ToolGroup[];
  }
  return out;
}

export interface ChannelToolsConfig {
  /** The Discord category whose channels get tools by name; undefined applies the map to no channel. */
  category?: string;
  /** Overrides and additions to the default map. */
  overrides?: Record<string, ToolGroup[] | 'all'>;
}

/** The groups a channel gets, from its name and the name of the category it's in. */
export function channelGroups(channelName: string, categoryName: string | undefined, cfg: ChannelToolsConfig): ReadonlySet<ToolGroup> {
  if (!cfg.category || !categoryName || categoryName.trim().toLowerCase() !== cfg.category.trim().toLowerCase()) return ALL_GROUPS;
  // Channel names often carry an emoji or a separator ("🏋️gym", "gym-log"); match on the words.
  const words = channelName.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const map = { ...DEFAULT_CHANNEL_TOOLS, ...(cfg.overrides ?? {}) };
  const key = map[channelName.toLowerCase()] !== undefined ? channelName.toLowerCase() : words.find((w) => map[w] !== undefined);
  const groups = key === undefined ? undefined : map[key];
  if (groups === undefined || groups === 'all') return ALL_GROUPS;
  return new Set(groups);
}

/** A stable key for a set of groups, for caching the system prompt built for it. */
export const groupsKey = (groups: ReadonlySet<ToolGroup>) => TOOL_GROUPS.filter((g) => groups.has(g)).join(',');

/** A line telling the model what this channel can't do, so it points the owner elsewhere instead of pretending. */
export function missingGroupsNote(groups: ReadonlySet<ToolGroup>): string {
  const missing = TOOL_GROUPS.filter((g) => !groups.has(g));
  if (missing.length === 0) return '';
  const what: Record<ToolGroup, string> = {
    notes: 'Obsidian notes',
    training: 'the training log',
    google: 'Gmail and Calendar',
    places: 'saved places',
    video: 'watching videos',
    expenses: 'the expense log',
  };
  return `\n\nThis channel is set up for its topic, so you don't have tools here for: ${missing.map((g) => what[g]).join(', ')}. If they ask for one of those, say in a few words that it works in their other channels (like #misc), rather than guessing.`;
}
