import type { PlanData } from '../../../lib/types';

/**
 * The local server owns the plan file; this is the only way the app touches it.
 * Every read carries a revision, and every write must present the revision it
 * read, so a change made from Discord can't be silently overwritten.
 */

export interface PlanSnapshot {
  rev: number;
  plan: PlanData | null;
}

export class ServerUnreachableError extends Error {
  constructor() {
    super('Cannot reach the training log server. Start it with "npm start" in the server directory.');
  }
}

export class PlanConflictError extends Error {
  snapshot: PlanSnapshot;
  constructor(snapshot: PlanSnapshot, message: string) {
    super(message);
    this.snapshot = snapshot;
  }
}

async function request(path: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(path, init);
  } catch {
    throw new ServerUnreachableError();
  }
}

export async function fetchPlan(): Promise<PlanSnapshot> {
  const response = await request('/api/plan');
  if (!response.ok) throw new Error(await errorText(response));
  return (await response.json()) as PlanSnapshot;
}

/** Returns the new revision, or throws PlanConflictError carrying the winning plan. */
export async function savePlan(rev: number, plan: PlanData): Promise<number> {
  const response = await request('/api/plan', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rev, plan }),
  });

  if (response.status === 409) {
    const body = (await response.json()) as PlanSnapshot & { error: string };
    throw new PlanConflictError({ rev: body.rev, plan: body.plan }, body.error);
  }
  if (!response.ok) throw new Error(await errorText(response));

  return ((await response.json()) as { rev: number }).rev;
}

/**
 * Subscribes to revision bumps. The callback fires whenever anything — this
 * tab, another tab, or the Discord bot — changes the plan.
 */
export function subscribeToChanges(onRevision: (rev: number) => void): () => void {
  const source = new EventSource('/api/events');
  source.addEventListener('rev', (event) => {
    const rev = Number((event as MessageEvent).data);
    if (Number.isFinite(rev)) onRevision(rev);
  });
  return () => source.close();
}

async function errorText(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string };
    return body.error ?? `Server returned ${response.status}.`;
  } catch {
    return `Server returned ${response.status}.`;
  }
}
