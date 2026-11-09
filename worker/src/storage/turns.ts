import { type Db, now, tx } from './db.js';
import type { RawEventRow } from './events.js';
import type { ParsedTurn } from '../compression/parser.js';

/** A turn = everything recorded between one user prompt and the next: the unit of compression. */
export interface TurnKey {
  sessionId: string;
  promptNumber: number | null;
}

export interface TurnData {
  key: TurnKey;
  project: string;
  prompt: string | null;
  events: RawEventRow[];
  summaryIds: number[];
  lastAssistantMessage: string | null;
  attempts: number;
}

/**
 * Turns ready to compress, oldest first: a Stop arrived (pending summary row), or the turn's
 * oldest pending event is older than orphanAfterMs (session crashed or Stop was lost).
 * A Stop younger than settleMs waits, so async PostToolUse events still in flight join the turn.
 */
export function readyTurns(db: Db, orphanAfterMs: number, settleMs: number, limit: number): TurnKey[] {
  const orphanBefore = new Date(Date.now() - orphanAfterMs).toISOString();
  const settledBefore = new Date(Date.now() - settleMs).toISOString();
  const rows = db
    .prepare(
      `SELECT session_id, prompt_number, MIN(first_at) AS first_at FROM (
         SELECT session_id, prompt_number, created_at AS first_at FROM summaries
           WHERE status = 'pending' AND created_at <= ?
         UNION ALL
         SELECT session_id, prompt_number, MIN(created_at) AS first_at FROM raw_events
           WHERE status = 'pending' GROUP BY session_id, prompt_number HAVING MIN(created_at) < ?
       ) GROUP BY session_id, prompt_number ORDER BY first_at LIMIT ?`,
    )
    .all(settledBefore, orphanBefore, limit) as { session_id: string; prompt_number: number | null }[];
  return rows.map((r) => ({ sessionId: r.session_id, promptNumber: r.prompt_number }));
}

export function loadTurn(db: Db, key: TurnKey): TurnData | null {
  const { sessionId, promptNumber } = key;
  const events = db
    .prepare(
      `SELECT * FROM raw_events WHERE session_id = ? AND prompt_number IS ? AND status = 'pending' ORDER BY id`,
    )
    .all(sessionId, promptNumber) as unknown as RawEventRow[];
  const summaries = db
    .prepare(
      `SELECT id, project, last_assistant_message, attempts FROM summaries
       WHERE session_id = ? AND prompt_number IS ? AND status = 'pending' ORDER BY id`,
    )
    .all(sessionId, promptNumber) as { id: number; project: string; last_assistant_message: string | null; attempts: number }[];
  if (events.length === 0 && summaries.length === 0) return null;

  const prompt = db
    .prepare('SELECT text FROM prompts WHERE session_id = ? AND prompt_number IS ?')
    .get(sessionId, promptNumber) as { text: string } | undefined;
  const last = summaries[summaries.length - 1];

  return {
    key,
    project: last?.project ?? events[0].project,
    prompt: prompt?.text ?? null,
    events,
    summaryIds: summaries.map((s) => s.id),
    lastAssistantMessage: last?.last_assistant_message ?? null,
    attempts: Math.max(0, ...events.map((e) => e.attempts), ...summaries.map((s) => s.attempts)),
  };
}

/** Stores the compressor's result for a turn and closes it, atomically. */
export function saveCompressedTurn(db: Db, turn: TurnData, parsed: ParsedTurn, shareableTypes: string[]): number[] {
  return tx(db, () => {
    const ids: number[] = [];
    const insert = db.prepare(
      `INSERT INTO observations
         (session_id, project, prompt_number, type, title, subtitle, narrative, facts, concepts, files, created_at, share_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const o of parsed.observations) {
      const res = insert.run(
        turn.key.sessionId, turn.project, turn.key.promptNumber, o.type, o.title, o.subtitle, o.narrative,
        JSON.stringify(o.facts), JSON.stringify(o.concepts), JSON.stringify(o.files), now(),
        shareableTypes.includes(o.type) ? 'pending' : 'local',
      );
      ids.push(Number(res.lastInsertRowid));
    }

    const status = parsed.skip ? 'skipped' : 'processed';
    const s = parsed.summary;
    const updateSummary = db.prepare(
      `UPDATE summaries SET status = ?, request = ?, investigated = ?, learned = ?, completed = ?, next_steps = ? WHERE id = ?`,
    );
    for (const id of turn.summaryIds) {
      updateSummary.run(status, s?.request ?? null, s?.investigated ?? null, s?.learned ?? null, s?.completed ?? null, s?.nextSteps ?? null, id);
    }
    const closeEvent = db.prepare(`UPDATE raw_events SET status = 'processed' WHERE id = ?`);
    for (const e of turn.events) closeEvent.run(e.id);
    return ids;
  });
}

/** Counts a failed attempt; past maxAttempts the turn is marked failed and leaves the queue. */
export function recordTurnFailure(db: Db, turn: TurnData, maxAttempts: number): boolean {
  const giveUp = turn.attempts + 1 >= maxAttempts;
  const status = giveUp ? 'failed' : 'pending';
  tx(db, () => {
    const ev = db.prepare('UPDATE raw_events SET attempts = attempts + 1, status = ? WHERE id = ?');
    for (const e of turn.events) ev.run(status, e.id);
    const su = db.prepare('UPDATE summaries SET attempts = attempts + 1, status = ? WHERE id = ?');
    for (const id of turn.summaryIds) su.run(status, id);
  });
  return giveUp;
}
