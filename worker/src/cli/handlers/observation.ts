import type { Settings } from '../../settings.js';
import type { HookPayload } from '../stdin.js';
import type { ObserveBody } from '../../server/ingest.js';
import { deliver } from './deliver.js';

/** PostToolUse / PostToolUseFailure: send the raw tool event; the distill agent reads it later. */
export async function handleObservation(settings: Settings, payload: HookPayload, event: string): Promise<void> {
  if (!payload.session_id || !payload.tool_name) return;
  if (settings.skipTools.includes(payload.tool_name)) return;
  const body: ObserveBody = {
    sessionId: payload.session_id,
    cwd: payload.cwd,
    event,
    toolName: payload.tool_name,
    toolInput: payload.tool_input,
    toolResponse: payload.tool_response ?? (payload.error !== undefined ? { error: payload.error } : undefined),
  };
  await deliver(settings, 'observe', body);
}
