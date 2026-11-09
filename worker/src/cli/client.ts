import type { Settings } from '../settings.js';

/** Thin HTTP client from hooks to the local worker. Every call is bounded. */
const base = (settings: Settings) => `http://127.0.0.1:${settings.port}`;

export async function workerHealthy(settings: Settings): Promise<boolean> {
  try {
    const res = await fetch(`${base(settings)}/health`, { signal: AbortSignal.timeout(settings.hookTimeoutMs) });
    if (!res.ok) return false;
    const body = (await res.json()) as { name?: string };
    // Guard against an unrelated service squatting the port.
    return body.name === 'eonix-mem';
  } catch {
    return false;
  }
}

export async function workerPost<T = unknown>(
  settings: Settings,
  route: string,
  body: unknown,
  timeoutMs = settings.hookTimeoutMs,
): Promise<T> {
  const res = await fetch(`${base(settings)}/api/${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`worker ${route} -> HTTP ${res.status}`);
  return (await res.json()) as T;
}

export async function workerGet<T>(settings: Settings, pathAndQuery: string): Promise<T> {
  const res = await fetch(`${base(settings)}${pathAndQuery}`, { signal: AbortSignal.timeout(settings.hookTimeoutMs) });
  if (!res.ok) throw new Error(`worker GET ${pathAndQuery} -> HTTP ${res.status}`);
  return (await res.json()) as T;
}
