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
import { AgentSdkProvider, resolveClaudePath, type AgentProvider } from '../compression/provider.js';
import { OutboxSender } from './outbox-sender.js';
import { serverConfigured } from './remote.js';

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

  const claudePath = resolveClaudePath(settings);
  const provider: AgentProvider | null = claudePath ? new AgentSdkProvider(settings, claudePath) : null;
  const outbox = new OutboxSender(db, settings);
  const distill = provider ? new DistillQueue(db, settings, provider) : null;
  // Consolidation needs the server; distill still writes local summaries without it.
  const consolidation = provider && serverConfigured(settings) ? new ConsolidationJob(db, settings, provider) : null;

  const drain = () => {
    const n = spoolDrain(
      (entry) => ingest(db, settings, entry.route, entry.body),
      (file, err) => log('worker', `spool entry ${file} rejected`, err),
    );
    if (n > 0) {
      log('worker', `drained ${n} spooled event(s)`);
      void outbox.flush();
    }
  };

  const shutdown = () => {
    if (drainTimer) clearInterval(drainTimer);
    outbox.stop();
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
    const app = createApp({ db, settings, startedAt, provider, kickOutbox: () => void outbox.flush(), shutdown });
    server = app.listen(settings.port, '127.0.0.1');
    server.on('listening', () => {
      fs.writeFileSync(paths.pid(), String(process.pid));
      log('worker', `listening on 127.0.0.1:${settings.port} (pid ${process.pid})`);
      log('worker', serverConfigured(settings)
        ? `server ${settings.serverUrl}`
        : 'server not configured: set EONIX_HOOK_TOKEN — episodes wait in the outbox, no notes injected or written');
      log('worker', provider
        ? `agents on (${settings.agentModel} via ${claudePath})`
        : 'agents off: no `claude` executable found (set claudePath in settings.json)');
      drain();
      drainTimer = setInterval(drain, settings.spoolDrainIntervalMs);
      outbox.start();
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
