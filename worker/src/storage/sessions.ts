import { type Db, now } from './db.js';

export interface SessionRow {
  id: string;
  project: string;
  cwd: string | null;
  started_at: string;
  ended_at: string | null;
  prompt_count: number;
}

/** Creates the session on first sight; later calls only refresh project/cwd. Idempotent. */
export function upsertSession(db: Db, id: string, project: string, cwd: string | undefined): void {
  db.prepare(
    `INSERT INTO sessions (id, project, cwd, started_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET project = excluded.project, cwd = COALESCE(excluded.cwd, sessions.cwd)`,
  ).run(id, project, cwd ?? null, now());
}

export function getSession(db: Db, id: string): SessionRow | undefined {
  return db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
}

export function markSessionEnded(db: Db, id: string): void {
  db.prepare('UPDATE sessions SET ended_at = ? WHERE id = ?').run(now(), id);
}
