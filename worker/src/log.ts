import fs from 'node:fs';
import path from 'node:path';
import { paths } from './settings.js';

/**
 * Append-only file logger. Hooks must never write to stdout/stderr (stdout is parsed by Claude Code),
 * so every diagnostic goes to ~/.eonix-mem/logs/<name>.log.
 */
export function log(name: 'hook' | 'worker', message: string, err?: unknown): void {
  try {
    fs.mkdirSync(paths.logs(), { recursive: true });
    const detail = err instanceof Error ? ` | ${err.stack ?? err.message}` : err ? ` | ${String(err)}` : '';
    fs.appendFileSync(path.join(paths.logs(), `${name}.log`), `${new Date().toISOString()} ${message}${detail}\n`);
  } catch {
    // Logging must never throw.
  }
}
