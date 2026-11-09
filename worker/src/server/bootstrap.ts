import { spawn } from 'node:child_process';
import type { Settings } from '../settings.js';
import { workerHealthy } from '../cli/client.js';
import { log } from '../log.js';

/**
 * Starts the worker on demand from a hook: if /health does not answer, spawn a detached
 * `eonix-mem start` that outlives the hook process, then wait (bounded) for it to come up.
 */
export async function ensureWorker(settings: Settings): Promise<boolean> {
  if (await workerHealthy(settings)) return true;

  // The CLI re-launches itself; EONIX_MEM_CLI overrides it when the caller is not the CLI (tests).
  const script = process.env.EONIX_MEM_CLI || process.argv[1];
  try {
    const child = spawn(process.execPath, ['--no-warnings', script, 'start'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: process.env,
    });
    child.unref();
    log('hook', `spawned worker (pid ${child.pid})`);
  } catch (err) {
    log('hook', 'failed to spawn worker', err);
    return false;
  }

  const deadline = Date.now() + settings.startupWaitMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 150));
    if (await workerHealthy(settings)) return true;
  }
  log('hook', `worker not healthy after ${settings.startupWaitMs} ms`);
  return false;
}
