import { type Db, now, tx } from './db.js';

/** Stores a user prompt and returns its 1-based number within the session. */
export function addPrompt(db: Db, sessionId: string, text: string): number {
  return tx(db, () => {
    db.prepare('UPDATE sessions SET prompt_count = prompt_count + 1 WHERE id = ?').run(sessionId);
    const { prompt_count } = db.prepare('SELECT prompt_count FROM sessions WHERE id = ?').get(sessionId) as {
      prompt_count: number;
    };
    db.prepare('INSERT INTO prompts (session_id, prompt_number, text, created_at) VALUES (?, ?, ?, ?)').run(
      sessionId, prompt_count, text, now(),
    );
    return prompt_count;
  });
}

export function currentPromptNumber(db: Db, sessionId: string): number | null {
  const row = db.prepare('SELECT prompt_count FROM sessions WHERE id = ?').get(sessionId) as
    | { prompt_count: number }
    | undefined;
  return row ? row.prompt_count : null;
}
