import type { Settings } from '../settings.js';

/**
 * The worker's only door to the Eonix server: the EXISTING hook endpoints, called with the raw
 * Claude Code hook payload exactly as the former hooks sent it. Nothing here needs a server change.
 */
export type HookEndpoint = 'capture' | 'session-start' | 'notes-check' | 'knowledge-check';

export class ServerError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
  }
}

export function serverConfigured(settings: Settings): boolean {
  return Boolean(settings.serverUrl && settings.serverToken);
}

/** POSTs a raw hook payload to /api/hook/<endpoint>; throws ServerError on any failure. */
export async function postHook(settings: Settings, endpoint: HookEndpoint, payload: unknown): Promise<unknown> {
  if (!serverConfigured(settings)) throw new ServerError('no server token configured', null);
  let res: Response;
  try {
    res = await fetch(`${settings.serverUrl}/api/hook/${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${settings.serverToken}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(settings.serverTimeoutMs),
    });
  } catch (err) {
    throw new ServerError(`network: ${err instanceof Error ? err.message : String(err)}`, null);
  }
  if (!res.ok) throw new ServerError(`HTTP ${res.status}`, res.status);
  return res.json().catch(() => ({}));
}

/** additionalContext of a server hook response, or '' when it injected nothing. */
export function additionalContextOf(response: unknown): string {
  const ctx = (response as { hookSpecificOutput?: { additionalContext?: unknown } })?.hookSpecificOutput
    ?.additionalContext;
  return typeof ctx === 'string' ? ctx : '';
}

/** MCP server config handed to background agents: the same /mcp endpoint, authenticated with the token. */
export function mcpServerConfig(settings: Settings) {
  return {
    type: 'http' as const,
    url: `${settings.serverUrl}/mcp`,
    headers: { Authorization: `Bearer ${settings.serverToken}` },
  };
}
