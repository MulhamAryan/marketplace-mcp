import { INTERNAL_ENV, loadSettings } from '../settings.js';
import { readStdin } from './stdin.js';
import { handleContext } from './handlers/context.js';
import { handlePrompt } from './handlers/prompt.js';
import { handleObservation } from './handlers/observation.js';
import { handleSummary } from './handlers/summary.js';
import { log } from '../log.js';

export const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PostToolUseFailure', 'Stop'] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

/**
 * Entry point of `eonix-mem hook <event>`. Contract with Claude Code: always exit 0, never write
 * anything to stdout except SessionStart's JSON, never block longer than the bounded timeouts.
 */
export async function runHook(event: string): Promise<void> {
  // Inside the worker's own compression session: record nothing, or it would compress itself forever.
  if (process.env[INTERNAL_ENV]) return;
  try {
    const settings = loadSettings();
    const payload = await readStdin(settings.stdinTimeoutMs);
    switch (event as HookEvent) {
      case 'SessionStart': {
        const context = await handleContext(settings, payload);
        if (context) {
          process.stdout.write(
            JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } }),
          );
        }
        break;
      }
      case 'UserPromptSubmit': {
        const context = await handlePrompt(settings, payload);
        if (context) {
          process.stdout.write(
            JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context } }),
          );
        }
        break;
      }
      case 'PostToolUse':
      case 'PostToolUseFailure':
        await handleObservation(settings, payload, event);
        break;
      case 'Stop':
        await handleSummary(settings, payload);
        break;
      default:
        log('hook', `unknown hook event "${event}" ignored`);
    }
  } catch (err) {
    log('hook', `hook ${event} failed`, err);
  }
}
