import fs from 'node:fs';
import type { Server } from 'node:http';
import { createApp } from './app.js';
import { ingest } from './ingest.js';
import { openDb } from '../storage/db.js';
import { loadSettings, paths } from '../settings.js';
import { spoolDrain } from '../cli/spool.js';
import { log } from '../log.js';
import { DistillQueue } from '../compression/queue.js';
import { ConsolidationJob } from '../compression/consolidation.js';
import { AgentSdkProvider, resolveClaudePath, resolvePluginRoot } from '../compression/provider.js';

/**
 * Runs the worker in the foreground. One worker per machine: the loopback port is the lock —
 * a second instance that loses the bind race exits quietly.
 */
export function runWorker(): Promise<void> {
  const settings = loadSettings();
  const db = openDb();
  const startedAt = Date.now();
  let server: Server;
  let drainTimer: NodeJS.Timeout | undefined;

  // Agents need the installed `claude` (model + login) and this plugin's root (OAuth MCP connector).
  const claudePath = resolveClaudePath(settings);
  const pluginRoot = resolvePluginRoot(settings);
  const provider = claudePath && pluginRoot ? new AgentSdkProvider(settings, claudePath, pluginRoot) : null;
  const consolidation = provider ? new ConsolidationJob(db, settings, provider) : null;
  // Each distilled turn triggers the consolidation of its project, ~consolidationDebounceMs later.
  const distill = provider ? new DistillQueue(db, settings, provider, (project) => consolidation?.request(project)) : null;

  const drain = () => {
    const n = spoolDrain(
      (entry) => ingest(db, settings, entry.route, entry.body),
      (file, err) => log('worker', `spool entry ${file} rejected`, err),
    );
    if (n > 0) log('worker', `drained ${n} spooled event(s)`);
  };

  const shutdown = () => {
    if (drainTimer) clearInterval(drainTimer);
    distill?.stop();
    consolidation?.stop();
    server.close(() => {
      db.close();
      try {
        fs.unlinkSync(paths.pid());
      } catch {
        // ignore
      }
      log('worker', 'stopped');
      process.exit(0);
    });
  };

  return new Promise((resolve) => {
    const agents = provider ? `${settings.agentModel} via ${claudePath}, plugin ${pluginRoot}` : null;
    server = createApp({ db, settings, startedAt, agents, shutdown }).listen(settings.port, '127.0.0.1');
    server.on('listening', () => {
      fs.writeFileSync(paths.pid(), String(process.pid));
      log('worker', `listening on 127.0.0.1:${settings.port} (pid ${process.pid})`);
      log('worker', agents
        ? `agents on (${agents})`
        : `agents off: claude=${claudePath ?? 'not found'} pluginRoot=${pluginRoot ?? 'not found'} (see claudePath / pluginRoot in settings.json)`);
      drain();
      drainTimer = setInterval(drain, settings.spoolDrainIntervalMs);
      distill?.start();
      consolidation?.start();
      resolve();
    });
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        log('worker', `port ${settings.port} already in use — another worker is running, exiting`);
        db.close();
        process.exit(0);
      }
      log('worker', 'server error', err);
      process.exit(1);
    });
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
}
