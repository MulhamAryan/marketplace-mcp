import express, { type NextFunction, type Request, type Response } from 'express';
import type { Db } from '../storage/db.js';
import type { Settings } from '../settings.js';
import { counts } from '../storage/stats.js';
import { BadRequest, ingest, type IngestRoute } from './ingest.js';
import { log } from '../log.js';
import { observationsByIds, searchObservations } from '../storage/observations.js';
import { renderIndexLine, renderObservation } from '../context/render.js';
import { sessionContext } from './session-context.js';

export const WORKER_VERSION = '0.2.0';

export interface AppDeps {
  db: Db;
  settings: Settings;
  startedAt: number;
  /** Background agents status, shown by /health; null when they are off. */
  agents: string | null;
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
      agents: deps.agents ?? 'off (no claude executable or plugin root)',
      counts: counts(db),
    });
  });

  const ingestRoute = (route: IngestRoute) => (req: Request, res: Response) => {
    res.json(ingest(db, settings, route, req.body ?? {}));
  };
  app.post('/api/prompt', ingestRoute('prompt'));
  app.post('/api/observe', ingestRoute('observe'));
  app.post('/api/summary', ingestRoute('summary'));

  // SessionStart: background notice + local memory of the project.
  app.post('/api/session-start', (req, res) => {
    const cwd = typeof req.body?.cwd === 'string' ? req.body.cwd : undefined;
    res.json({ context: sessionContext(db, settings, cwd, deps.agents !== null) });
  });

  // Layer 2 of progressive recall: full-text search, returns index lines (cheap).
  app.get('/api/search', (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    const project = typeof req.query.project === 'string' && req.query.project ? req.query.project : undefined;
    const rows = searchObservations(db, q, project, 20);
    res.json({ text: rows.length ? rows.map(renderIndexLine).join('\n') : 'Aucune observation trouvée.' });
  });

  // Layer 3: full observations by id.
  app.get('/api/observations', (req, res) => {
    const ids = String(req.query.ids ?? '')
      .split(',')
      .map((s) => Number(s.replace(/^#/, '')))
      .filter((n) => Number.isInteger(n) && n > 0);
    const rows = observationsByIds(db, ids);
    res.json({ text: rows.length ? rows.map(renderObservation).join('\n\n') : 'Aucune observation avec ces ids.' });
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
