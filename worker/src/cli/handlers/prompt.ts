import type { Settings } from '../../settings.js';
import type { HookPayload } from '../stdin.js';
import type { PromptBody } from '../../server/ingest.js';
import { deliver } from './deliver.js';

/** UserPromptSubmit: record the prompt (relayed as an episode) and return the notes/norms to inject. */
export async function handlePrompt(settings: Settings, payload: HookPayload): Promise<string> {
  if (!payload.session_id || typeof payload.prompt !== 'string') return '';
  const body: PromptBody = {
    sessionId: payload.session_id,
    cwd: payload.cwd,
    prompt: payload.prompt,
    raw: { ...payload, hook_event_name: 'UserPromptSubmit' },
  };
  const answer = await deliver<{ context?: string }>(settings, 'prompt', body, settings.promptHookTimeoutMs);
  return answer?.context ?? '';
}
