import type { Settings } from '../../settings.js';
import type { IngestRoute } from '../../server/ingest.js';
import { ensureWorker } from '../../server/bootstrap.js';
import { workerPost } from '../client.js';
import { spoolWrite } from '../spool.js';
import { log } from '../../log.js';

/**
 * Sends one body to the worker. On failure: start the worker and retry once; if it is still
 * unreachable, spool the body so nothing is lost. Never throws.
 */
export async function deliver(settings: Settings, route: IngestRoute, body: unknown): Promise<void> {
  try {
    await workerPost(settings, route, body);
    return;
  } catch {
    // Worker down or slow: fall through to bootstrap.
  }
  try {
    if (await ensureWorker(settings)) {
      await workerPost(settings, route, body);
      return;
    }
  } catch (err) {
    log('hook', `${route} retry failed`, err);
  }
  try {
    spoolWrite(route, body);
    log('hook', `${route} spooled`);
  } catch (err) {
    log('hook', `${route} lost: spool write failed`, err);
  }
}
