import { DatabaseSync } from 'node:sqlite';
import { ensureDataDir, paths } from '../settings.js';

/**
 * Ordered schema migrations, applied once each and tracked with PRAGMA user_version.
 * Never edit a shipped migration: append a new one.
 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE sessions (
    id            TEXT PRIMARY KEY,           -- Claude Code session_id
    project       TEXT NOT NULL,
    cwd           TEXT,
    started_at    TEXT NOT NULL,
    ended_at      TEXT,
    prompt_count  INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX ix_sessions_project ON sessions(project, started_at);

  CREATE TABLE prompts (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id     TEXT NOT NULL REFERENCES sessions(id),
    prompt_number  INTEGER NOT NULL,
    text           TEXT NOT NULL,
    created_at     TEXT NOT NULL
  );
  CREATE INDEX ix_prompts_session ON prompts(session_id, prompt_number);

  CREATE VIRTUAL TABLE prompts_fts USING fts5(text, content='prompts', content_rowid='id');
  CREATE TRIGGER prompts_ai AFTER INSERT ON prompts BEGIN
    INSERT INTO prompts_fts(rowid, text) VALUES (new.id, new.text);
  END;

  -- Raw hook events: stored immediately, compressed later (status pending -> processed | failed).
  CREATE TABLE raw_events (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id     TEXT NOT NULL REFERENCES sessions(id),
    project        TEXT NOT NULL,
    prompt_number  INTEGER,
    event          TEXT NOT NULL,             -- PostToolUse | PostToolUseFailure
    tool_name      TEXT,
    tool_input     TEXT,
    tool_response  TEXT,
    created_at     TEXT NOT NULL,
    status         TEXT NOT NULL DEFAULT 'pending',
    attempts       INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX ix_raw_events_status ON raw_events(status, id);

  -- Compressed observations, filled by the compression queue.
  CREATE TABLE observations (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id     TEXT NOT NULL REFERENCES sessions(id),
    project        TEXT NOT NULL,
    prompt_number  INTEGER,
    type           TEXT NOT NULL,             -- Decision | BusinessRule | Bug | Pitfall | Documentation | Change | Discovery
    title          TEXT NOT NULL,
    subtitle       TEXT,
    narrative      TEXT,
    facts          TEXT,                      -- JSON array of strings
    concepts       TEXT,                      -- JSON array of strings
    files          TEXT,                      -- JSON array of paths
    created_at     TEXT NOT NULL,
    share_status   TEXT NOT NULL DEFAULT 'local'  -- local | pending | pushed
  );
  CREATE INDEX ix_observations_project ON observations(project, created_at);
  CREATE INDEX ix_observations_share ON observations(share_status, id);

  CREATE VIRTUAL TABLE observations_fts USING fts5(
    title, subtitle, narrative, facts, concepts,
    content='observations', content_rowid='id'
  );
  CREATE TRIGGER observations_ai AFTER INSERT ON observations BEGIN
    INSERT INTO observations_fts(rowid, title, subtitle, narrative, facts, concepts)
    VALUES (new.id, new.title, new.subtitle, new.narrative, new.facts, new.concepts);
  END;
  CREATE TRIGGER observations_ad AFTER DELETE ON observations BEGIN
    INSERT INTO observations_fts(observations_fts, rowid, title, subtitle, narrative, facts, concepts)
    VALUES ('delete', old.id, old.title, old.subtitle, old.narrative, old.facts, old.concepts);
  END;
  CREATE TRIGGER observations_au AFTER UPDATE ON observations BEGIN
    INSERT INTO observations_fts(observations_fts, rowid, title, subtitle, narrative, facts, concepts)
    VALUES ('delete', old.id, old.title, old.subtitle, old.narrative, old.facts, old.concepts);
    INSERT INTO observations_fts(rowid, title, subtitle, narrative, facts, concepts)
    VALUES (new.id, new.title, new.subtitle, new.narrative, new.facts, new.concepts);
  END;

  -- End-of-turn summaries: requested at Stop, filled by the compression queue.
  CREATE TABLE summaries (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id              TEXT NOT NULL REFERENCES sessions(id),
    project                 TEXT NOT NULL,
    prompt_number           INTEGER,
    last_assistant_message  TEXT,
    request                 TEXT,
    investigated            TEXT,
    learned                 TEXT,
    completed               TEXT,
    next_steps              TEXT,
    created_at              TEXT NOT NULL,
    status                  TEXT NOT NULL DEFAULT 'pending'
  );
  CREATE INDEX ix_summaries_project ON summaries(project, created_at);
  `,
  // 2: compression bookkeeping on summaries (a turn's Stop row carries its retry count).
  `
  ALTER TABLE summaries ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
  CREATE INDEX ix_summaries_status ON summaries(status, id);
  CREATE INDEX ix_raw_events_turn ON raw_events(session_id, prompt_number, status);
  `,
  // 3: the worker is the only door to the server. Episodes wait in an outbox until the server
  // acknowledges them; observations remember which team note (target) they were pushed as.
  `
  CREATE TABLE server_outbox (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    endpoint    TEXT NOT NULL,             -- capture
    payload     TEXT NOT NULL,             -- raw Claude Code hook payload, relayed as-is
    created_at  TEXT NOT NULL,
    attempts    INTEGER NOT NULL DEFAULT 0,
    last_error  TEXT
  );
  ALTER TABLE observations ADD COLUMN target TEXT;
  UPDATE observations SET share_status = 'local' WHERE share_status = 'pending';
  `,
];

export type Db = DatabaseSync;

export function openDb(file: string = paths.db()): Db {
  if (file !== ':memory:') ensureDataDir();
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  for (let v = row.user_version; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

/** Runs fn in a transaction; rolls back on throw. */
export function tx<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export const now = () => new Date().toISOString();
