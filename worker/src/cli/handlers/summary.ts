import type { Settings } from '../../settings.js';
import type { HookPayload } from '../stdin.js';
import type { SummaryBody } from '../../server/ingest.js';
import { deliver } from './deliver.js';

/** Stop: close the turn (relayed as an episode); the worker then distills it in the background. */
export async function handleSummary(settings: Settings, payload: HookPayload): Promise<void> {
  if (!payload.session_id) return;
  const body: SummaryBody = {
    sessionId: payload.session_id,
    cwd: payload.cwd,
    lastAssistantMessage: payload.last_assistant_message,
    raw: { ...payload, hook_event_name: 'Stop' },
  };
  await deliver(settings, 'summary', body);
}
