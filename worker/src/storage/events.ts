import { type Db, now } from './db.js';

export interface RawEventInput {
  sessionId: string;
  project: string;
  promptNumber: number | null;
  event: string;
  toolName: string | null;
  toolInput: string | null;
  toolResponse: string | null;
}

export interface RawEventRow {
  id: number;
  session_id: string;
  project: string;
  prompt_number: number | null;
  event: string;
  tool_name: string | null;
  tool_input: string | null;
  tool_response: string | null;
  created_at: string;
  status: string;
  attempts: number;
}

export function addRawEvent(db: Db, e: RawEventInput): number {
  const res = db
    .prepare(
      `INSERT INTO raw_events (session_id, project, prompt_number, event, tool_name, tool_input, tool_response, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(e.sessionId, e.project, e.promptNumber, e.event, e.toolName, e.toolInput, e.toolResponse, now());
  return Number(res.lastInsertRowid);
}

export function pendingRawEvents(db: Db, limit: number): RawEventRow[] {
  return db
    .prepare(`SELECT * FROM raw_events WHERE status = 'pending' ORDER BY id LIMIT ?`)
    .all(limit) as unknown as RawEventRow[];
}

export function setRawEventStatus(db: Db, ids: number[], status: 'processed' | 'failed' | 'pending'): void {
  const stmt = db.prepare('UPDATE raw_events SET status = ?, attempts = attempts + 1 WHERE id = ?');
  for (const id of ids) stmt.run(status, id);
}
