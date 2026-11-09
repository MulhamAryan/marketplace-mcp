import type { Settings } from '../../settings.js';
import type { HookPayload } from '../stdin.js';
import type { SummaryBody } from '../../server/ingest.js';
import { deliver } from './deliver.js';

/** Stop: queue an end-of-turn summary request with the last assistant message. */
export async function handleSummary(settings: Settings, payload: HookPayload): Promise<void> {
  if (!payload.session_id) return;
  const body: SummaryBody = {
    sessionId: payload.session_id,
    cwd: payload.cwd,
    lastAssistantMessage: payload.last_assistant_message,
  };
  await deliver(settings, 'summary', body);
}
