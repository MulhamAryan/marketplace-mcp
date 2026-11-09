/**
 * Claude Code hook payload (the JSON written on the hook's stdin). Only the fields we use.
 */
export interface HookPayload {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  prompt?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: unknown;
  error?: unknown;
  last_assistant_message?: string;
  source?: string;
}

/** Reads and parses stdin; resolves to {} on empty/invalid input or after timeoutMs (no stdin attached). */
export function readStdin(timeoutMs: number): Promise<HookPayload> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve({});
      return;
    }
    const chunks: Buffer[] = [];
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        const text = Buffer.concat(chunks).toString('utf8').trim();
        resolve(text ? (JSON.parse(text) as HookPayload) : {});
      } catch {
        resolve({});
      }
    };
    const timer = setTimeout(finish, timeoutMs);
    process.stdin.on('data', (c: Buffer) => chunks.push(c));
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
  });
}
