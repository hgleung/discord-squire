import express from 'express';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { PlanStore } from './store.js';
import { RevisionConflictError } from './store.js';
import { InvalidPlanFileError } from '../../../lib/planFile.js';

const here = dirname(fileURLToPath(import.meta.url));
const DIST = join(here, '../../../web/dist');

export function createApp(store: PlanStore) {
  const app = express();
  app.use(express.json({ limit: '32mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, file: store.file, hasPlan: store.exists() });
  });

  app.get('/api/plan', (_req, res) => {
    if (!store.exists()) {
      // Not an error: the web app shows first-run setup and POSTs a new plan.
      res.json({ rev: 0, plan: null });
      return;
    }
    try {
      res.json({ rev: store.rev, plan: store.load() });
    } catch (err) {
      res.status(500).json({ error: message(err) });
    }
  });

  app.put('/api/plan', (req, res) => {
    const { rev, plan } = req.body ?? {};
    if (typeof plan !== 'object' || plan === null) {
      res.status(400).json({ error: 'Body must be { rev, plan }.' });
      return;
    }
    try {
      // A first write against an empty file carries rev 0 and needs no check.
      const next = store.exists() ? store.save(plan, Number(rev)) : store.init(plan);
      res.json({ rev: next });
    } catch (err) {
      if (err instanceof RevisionConflictError) {
        // Hand back the winning plan so the client can reconcile without a round trip.
        res.status(409).json({ error: err.message, rev: store.rev, plan: store.load() });
        return;
      }
      res.status(err instanceof InvalidPlanFileError ? 400 : 500).json({ error: message(err) });
    }
  });

  /**
   * Server-sent events, so a set logged from Discord appears in an open browser
   * without a refresh. Only the revision is pushed; the client refetches, which
   * keeps a single code path for loading.
   */
  app.get('/api/events', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(`event: rev\ndata: ${store.exists() ? store.rev : 0}\n\n`);

    const onChange = (rev: number) => res.write(`event: rev\ndata: ${rev}\n\n`);
    store.on('change', onChange);

    // Proxies and phones drop idle connections; a comment every 25s keeps it open.
    const keepAlive = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => {
      clearInterval(keepAlive);
      store.off('change', onChange);
    });
  });

  // Serve the built web app when it exists, so one process runs everything.
  if (existsSync(DIST)) {
    app.use(express.static(DIST));
    app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(join(DIST, 'index.html')));
  }

  return app;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
