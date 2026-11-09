import fs from 'node:fs';
import type { Server } from 'node:http';
import { createApp } from './app.js';
import { ingest } from './ingest.js';
import { openDb } from '../storage/db.js';
import { loadSettings, paths } from '../settings.js';
import { spoolDrain } from '../cli/spool.js';
import { log } from '../log.js';

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

  const drain = () => {
    const n = spoolDrain(
      (entry) => ingest(db, settings, entry.route, entry.body),
      (file, err) => log('worker', `spool entry ${file} rejected`, err),
    );
    if (n > 0) log('worker', `drained ${n} spooled event(s)`);
  };

  const shutdown = () => {
    if (drainTimer) clearInterval(drainTimer);
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
    server = createApp({ db, settings, startedAt, shutdown }).listen(settings.port, '127.0.0.1');
    server.on('listening', () => {
      fs.writeFileSync(paths.pid(), String(process.pid));
      log('worker', `listening on 127.0.0.1:${settings.port} (pid ${process.pid})`);
      drain();
      drainTimer = setInterval(drain, settings.spoolDrainIntervalMs);
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
