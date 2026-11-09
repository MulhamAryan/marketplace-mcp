import { type Db, now } from './db.js';

/** Records an end-of-turn summary request; the compression queue fills the fields later. */
export function addSummaryRequest(
  db: Db,
  sessionId: string,
  project: string,
  promptNumber: number | null,
  lastAssistantMessage: string | null,
): number {
  const res = db
    .prepare(
      `INSERT INTO summaries (session_id, project, prompt_number, last_assistant_message, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(sessionId, project, promptNumber, lastAssistantMessage, now());
  return Number(res.lastInsertRowid);
}
