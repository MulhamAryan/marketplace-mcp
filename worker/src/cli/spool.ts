import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { paths } from '../settings.js';
import type { IngestRoute } from '../server/ingest.js';

/**
 * Local spool: when the worker is unreachable, a hook writes its API body here instead of losing it.
 * One file per event (atomic rename, no concurrent-append corruption); the worker drains them in order.
 */
export interface SpoolEntry {
  route: IngestRoute;
  body: unknown;
  at: string;
}

export function spoolWrite(route: IngestRoute, body: unknown): void {
  const dir = paths.spool();
  fs.mkdirSync(dir, { recursive: true });
  const name = `${Date.now()}-${process.pid}-${crypto.randomBytes(4).toString('hex')}.json`;
  const entry: SpoolEntry = { route, body, at: new Date().toISOString() };
  const tmp = path.join(dir, `${name}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(entry));
  fs.renameSync(tmp, path.join(dir, name));
}

/** Replays every spooled entry through `apply`, oldest first; an entry is deleted once applied. */
export function spoolDrain(apply: (entry: SpoolEntry) => void, onError: (file: string, err: unknown) => void): number {
  const dir = paths.spool();
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  } catch {
    return 0;
  }
  let drained = 0;
  for (const file of files) {
    const full = path.join(dir, file);
    try {
      apply(JSON.parse(fs.readFileSync(full, 'utf8')) as SpoolEntry);
      fs.unlinkSync(full);
      drained++;
    } catch (err) {
      onError(file, err);
      // Keep the file aside so one poison entry never blocks the rest.
      try {
        fs.renameSync(full, `${full}.failed`);
      } catch {
        // ignore
      }
    }
  }
  return drained;
}
