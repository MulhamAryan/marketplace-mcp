import type { Settings } from '../../settings.js';
import type { HookPayload } from '../stdin.js';
import { ensureWorker } from '../../server/bootstrap.js';
import { workerGet } from '../client.js';
import { log } from '../../log.js';

/** SessionStart: start the worker, then return the context to inject (empty string = inject nothing). */
export async function handleContext(settings: Settings, payload: HookPayload): Promise<string> {
  if (!(await ensureWorker(settings))) return '';
  try {
    const q = new URLSearchParams({ cwd: payload.cwd ?? '' });
    const { context } = await workerGet<{ context: string }>(settings, `/api/context?${q}`);
    return context;
  } catch (err) {
    log('hook', 'context fetch failed', err);
    return '';
  }
}
