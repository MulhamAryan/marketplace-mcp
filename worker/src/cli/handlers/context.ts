import type { Settings } from '../../settings.js';
import type { HookPayload } from '../stdin.js';
import { ensureWorker } from '../../server/bootstrap.js';
import { workerPost } from '../client.js';
import { log } from '../../log.js';

/** SessionStart: start the worker, then return the context to inject (empty string = inject nothing). */
export async function handleContext(settings: Settings, payload: HookPayload): Promise<string> {
  if (!(await ensureWorker(settings))) return '';
  try {
    const { context } = await workerPost<{ context: string }>(settings, 'session-start', payload, settings.sessionStartTimeoutMs);
    return context;
  } catch (err) {
    log('hook', 'session-start context failed', err);
    return '';
  }
}
