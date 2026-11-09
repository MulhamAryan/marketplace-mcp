import type { Settings } from '../../settings.js';
import type { HookPayload } from '../stdin.js';
import type { PromptBody } from '../../server/ingest.js';
import { deliver } from './deliver.js';

/** UserPromptSubmit: initialise the session and record the prompt. */
export async function handlePrompt(settings: Settings, payload: HookPayload): Promise<void> {
  if (!payload.session_id || typeof payload.prompt !== 'string') return;
  const body: PromptBody = { sessionId: payload.session_id, cwd: payload.cwd, prompt: payload.prompt };
  await deliver(settings, 'prompt', body);
}
