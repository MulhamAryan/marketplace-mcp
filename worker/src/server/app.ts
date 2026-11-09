import express, { type NextFunction, type Request, type Response } from 'express';
import type { Db } from '../storage/db.js';
import type { Settings } from '../settings.js';
import { counts } from '../storage/stats.js';
import { BadRequest, ingest, type IngestRoute } from './ingest.js';
import { buildContext } from '../context/builder.js';
import { log } from '../log.js';

export const WORKER_VERSION = '0.1.0';

export interface AppDeps {
  db: Db;
  settings: Settings;
  startedAt: number;
  /** Called by POST /api/shutdown; the server owner closes the listener and exits. */
  shutdown: () => void;
}

/**
 * Worker HTTP API, loopback only. No UI here by design: the visual lives on marketplace.eonix.be.
 */
export function createApp(deps: AppDeps) {
  const { db, settings } = deps;
  const app = express();
  app.use(express.json({ limit: '5mb' }));

  app.get('/health', (_req, res) => {
    res.json({
      ok: true,
      name: 'eonix-mem',
      version: WORKER_VERSION,
      pid: process.pid,
      port: settings.port,
      uptimeSec: Math.round((Date.now() - deps.startedAt) / 1000),
      counts: counts(db),
    });
  });

  const ingestRoute = (route: IngestRoute) => (req: Request, res: Response) => {
    res.json(ingest(db, settings, route, req.body ?? {}));
  };
  app.post('/api/prompt', ingestRoute('prompt'));
  app.post('/api/observe', ingestRoute('observe'));
  app.post('/api/summary', ingestRoute('summary'));

  app.get('/api/context', (req, res) => {
    const cwd = typeof req.query.cwd === 'string' ? req.query.cwd : undefined;
    res.json({ context: buildContext(db, settings, cwd) });
  });

  app.post('/api/shutdown', (_req, res) => {
    res.json({ ok: true });
    setImmediate(deps.shutdown);
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof BadRequest) {
      res.status(400).json({ error: err.message });
      return;
    }
    log('worker', 'request failed', err);
    res.status(500).json({ error: 'internal error' });
  });

  return app;
}
