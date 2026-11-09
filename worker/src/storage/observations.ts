import type { Db } from './db.js';

export interface ObservationRow {
  id: number;
  session_id: string;
  project: string;
  prompt_number: number | null;
  type: string;
  title: string;
  subtitle: string | null;
  narrative: string | null;
  facts: string | null;
  concepts: string | null;
  files: string | null;
  created_at: string;
  share_status: string;
}

export interface SummaryRow {
  id: number;
  session_id: string;
  request: string | null;
  learned: string | null;
  completed: string | null;
  next_steps: string | null;
  created_at: string;
}

export function recentObservations(db: Db, project: string, limit: number): ObservationRow[] {
  return db
    .prepare('SELECT * FROM observations WHERE project = ? ORDER BY id DESC LIMIT ?')
    .all(project, limit) as unknown as ObservationRow[];
}

export function recentSummaries(db: Db, project: string, limit: number): SummaryRow[] {
  return db
    .prepare(
      `SELECT id, session_id, request, learned, completed, next_steps, created_at FROM summaries
       WHERE project = ? AND status = 'processed' ORDER BY id DESC LIMIT ?`,
    )
    .all(project, limit) as unknown as SummaryRow[];
}

export function observationsByIds(db: Db, ids: number[]): ObservationRow[] {
  if (ids.length === 0) return [];
  const marks = ids.map(() => '?').join(',');
  return db.prepare(`SELECT * FROM observations WHERE id IN (${marks}) ORDER BY id`).all(...ids) as unknown as ObservationRow[];
}

/** Full-text search over observations (FTS5), best match first; optional project filter. */
export function searchObservations(db: Db, query: string, project: string | undefined, limit: number): ObservationRow[] {
  // Quote every term so user input can never be parsed as FTS5 syntax.
  const match = query
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, '""')}"`)
    .join(' ');
  if (!match) return [];
  return db
    .prepare(
      `SELECT o.* FROM observations_fts f JOIN observations o ON o.id = f.rowid
       WHERE observations_fts MATCH ? AND (? IS NULL OR o.project = ?)
       ORDER BY bm25(observations_fts) LIMIT ?`,
    )
    .all(match, project ?? null, project ?? null, limit) as unknown as ObservationRow[];
}
