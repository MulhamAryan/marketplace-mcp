import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/storage/db.js';
import { ingestObservation, ingestPrompt, ingestSummary, BadRequest } from '../src/server/ingest.js';
import { pendingRawEvents } from '../src/storage/events.js';
import { counts } from '../src/storage/stats.js';
import { DEFAULT_SETTINGS } from '../src/settings.js';
import { projectFromCwd } from '../src/project.js';

const settings = { ...DEFAULT_SETTINGS, maxToolResponseChars: 50 };

test('projectFromCwd takes the last folder for Windows and POSIX paths', () => {
  assert.equal(projectFromCwd('D:\\projects\\skill-marketplace'), 'skill-marketplace');
  assert.equal(projectFromCwd('/home/dev/gob/'), 'gob');
  assert.equal(projectFromCwd(undefined), 'unknown');
});

test('prompts are numbered per session and searchable with FTS5', () => {
  const db = openDb(':memory:');
  assert.equal(ingestPrompt(db, { sessionId: 's1', cwd: 'D:\\p\\demo', prompt: 'fix the login bug' }).promptNumber, 1);
  assert.equal(ingestPrompt(db, { sessionId: 's1', cwd: 'D:\\p\\demo', prompt: 'now add tests' }).promptNumber, 2);
  assert.equal(ingestPrompt(db, { sessionId: 's2', cwd: 'D:\\p\\demo', prompt: 'other session' }).promptNumber, 1);
  const hits = db.prepare(`SELECT rowid FROM prompts_fts WHERE prompts_fts MATCH 'login'`).all();
  assert.equal(hits.length, 1);
});

test('observations are stored raw with the current prompt number, truncated, skip-listed tools dropped', () => {
  const db = openDb(':memory:');
  ingestPrompt(db, { sessionId: 's1', cwd: '/x/demo', prompt: 'p' });
  const r = ingestObservation(db, settings, {
    sessionId: 's1', cwd: '/x/demo', event: 'PostToolUse', toolName: 'Edit',
    toolInput: { file_path: 'a.ts' }, toolResponse: 'x'.repeat(200),
  });
  assert.equal(r.stored, true);
  assert.equal(ingestObservation(db, settings, { sessionId: 's1', event: 'PostToolUse', toolName: 'TodoWrite' }).stored, false);

  const [row] = pendingRawEvents(db, 10);
  assert.equal(row.tool_name, 'Edit');
  assert.equal(row.prompt_number, 1);
  assert.equal(row.project, 'demo');
  assert.equal(row.tool_input, '{"file_path":"a.ts"}');
  assert.match(row.tool_response!, /truncated 150 chars/);
});

test('summary request closes the session; missing sessionId is a 400', () => {
  const db = openDb(':memory:');
  ingestSummary(db, { sessionId: 's1', cwd: '/x/demo', lastAssistantMessage: 'done' });
  assert.deepEqual(
    { sessions: counts(db).sessions, summaries: counts(db).summaries },
    { sessions: 1, summaries: 1 },
  );
  assert.throws(() => ingestSummary(db, { sessionId: '' }), BadRequest);
});
