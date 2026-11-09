import type { Settings } from '../../settings.js';
import type { IngestRoute } from '../../server/ingest.js';
import { ensureWorker } from '../../server/bootstrap.js';
import { workerPost } from '../client.js';
import { spoolWrite } from '../spool.js';
import { log } from '../../log.js';

/**
 * Sends one body to the worker and returns its answer. On failure: start the worker and retry once;
 * if it is still unreachable, spool the body (replayed later, episodes included) and return null.
 * Never throws.
 */
export async function deliver<T = unknown>(
  settings: Settings,
  route: IngestRoute,
  body: unknown,
  timeoutMs = settings.hookTimeoutMs,
): Promise<T | null> {
  try {
    return await workerPost<T>(settings, route, body, timeoutMs);
  } catch {
    // Worker down or slow: fall through to bootstrap.
  }
  try {
    if (await ensureWorker(settings)) return await workerPost<T>(settings, route, body, timeoutMs);
  } catch (err) {
    log('hook', `${route} retry failed`, err);
  }
  try {
    spoolWrite(route, body);
    log('hook', `${route} spooled`);
  } catch (err) {
    log('hook', `${route} lost: spool write failed`, err);
  }
  return null;
}
