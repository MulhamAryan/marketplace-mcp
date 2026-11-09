import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConsolidationJob, activeProjects } from '../src/compression/consolidation.js';
import { sessionContext, BACKGROUND_NOTICE } from '../src/server/session-context.js';
import { openDb } from '../src/storage/db.js';
import { ingestPrompt } from '../src/server/ingest.js';
import { DEFAULT_SETTINGS } from '../src/settings.js';
import { FakeProvider } from './helpers.js';

test('consolidation runs the existing loop per active project with exactly its four tools', async () => {
  const db = openDb(':memory:');
  ingestPrompt(db, { sessionId: 's1', cwd: '/p/gob', prompt: 'x' });
  ingestPrompt(db, { sessionId: 's2', cwd: '/p/hub', prompt: 'y' });
  assert.deepEqual(activeProjects(db, 14), ['gob', 'hub']);
  const provider = new FakeProvider({
    text: '1 note',
    toolCalls: [{ tool: 'remember', input: {}, ok: true, result: '{}' }, { tool: 'mark_consolidated', input: {}, ok: true, result: '{}' }],
  });
  const notes = await new ConsolidationJob(db, { ...DEFAULT_SETTINGS, consolidationClustersPerRun: 2 }, provider).runOnce();
  assert.equal(notes, 2);
  assert.equal(provider.requests.length, 2);
  assert.deepEqual(provider.requests[0].mcpTools, ['pending_consolidations', 'list_cibles', 'remember', 'mark_consolidated']);
  assert.match(provider.requests[0].systemPrompt, /project "gob"/);
  assert.match(provider.requests[0].systemPrompt, /at most 2 clusters/);
});

test('SessionStart context: background notice only when agents run, always within the character cap', () => {
  const db = openDb(':memory:');
  assert.equal(sessionContext(db, DEFAULT_SETTINGS, '/p/demo', false), '', 'no agents, no memory: nothing');
  const ctx = sessionContext(db, DEFAULT_SETTINGS, '/p/demo', true);
  assert.equal(ctx, BACKGROUND_NOTICE);
  assert.match(ctx, /même si un rappel te le propose/, 'answers the consolidation nudge of hook_consolidation_check');
  assert.ok(ctx.length <= DEFAULT_SETTINGS.contextMaxChars);
});
