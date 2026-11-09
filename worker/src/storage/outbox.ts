import { type Db, now } from './db.js';

export interface OutboxRow {
  id: number;
  endpoint: string;
  payload: string;
  attempts: number;
}

export function enqueueOutbox(db: Db, endpoint: string, payload: unknown): void {
  db.prepare('INSERT INTO server_outbox (endpoint, payload, created_at) VALUES (?, ?, ?)').run(
    endpoint, JSON.stringify(payload), now(),
  );
}

export function nextOutbox(db: Db, limit: number): OutboxRow[] {
  return db.prepare('SELECT id, endpoint, payload, attempts FROM server_outbox ORDER BY id LIMIT ?').all(limit) as unknown as OutboxRow[];
}

export function ackOutbox(db: Db, id: number): void {
  db.prepare('DELETE FROM server_outbox WHERE id = ?').run(id);
}

export function failOutbox(db: Db, id: number, error: string): void {
  db.prepare('UPDATE server_outbox SET attempts = attempts + 1, last_error = ? WHERE id = ?').run(error, id);
}

export function dropExhaustedOutbox(db: Db, maxAttempts: number): number {
  return Number(db.prepare('DELETE FROM server_outbox WHERE attempts >= ?').run(maxAttempts).changes);
}
