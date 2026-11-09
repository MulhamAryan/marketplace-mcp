import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { parseTriage, promptContext } from '../src/server/prompt-context.js';
import { stripConsolidationNudge } from '../src/server/session-context.js';
import { ConsolidationJob, activeProjects } from '../src/compression/consolidation.js';
import { openDb } from '../src/storage/db.js';
import { ingestPrompt } from '../src/server/ingest.js';
import { DEFAULT_SETTINGS } from '../src/settings.js';
import { FakeProvider } from './helpers.js';

async function fakeServer(notes: string[], knowledge: string[]) {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const lines = req.url?.endsWith('notes-check') ? notes : knowledge;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(lines.length ? { hookSpecificOutput: { additionalContext: `Header:\n${lines.join('\n')}` } } : {}));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const settings = { ...DEFAULT_SETTINGS, serverUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, serverToken: 't' };
  return { server, settings };
}

test('few candidates: notes and norms injected exactly as the server wrote them, no agent call', async () => {
  const { server, settings } = await fakeServer(['- [Bug] bug:a: x'], ['- [API / Guide] Deploy: y']);
  const provider = new FakeProvider({ text: '1', toolCalls: [] });
  const ctx = await promptContext(settings, provider, { prompt: 'p' });
  server.close();
  assert.equal(ctx, 'Header:\n- [Bug] bug:a: x\n\nHeader:\n- [API / Guide] Deploy: y');
  assert.equal(provider.requests.length, 0);
});

test('many candidates: the triage agent keeps only the relevant ones, headers preserved', async () => {
  const notes = Array.from({ length: 4 }, (_, i) => `- [Pitfall] pitfall:n${i + 1}: note ${i + 1}`);
  const norms = ['- [DevOps / Guide] K1: norme 1', '- [DevOps / Guide] K2: norme 2'];
  const { server, settings } = await fakeServer(notes, norms);
  const provider = new FakeProvider({ text: '2, 6', toolCalls: [] });
  const ctx = await promptContext(settings, provider, { prompt: 'deploy' });
  server.close();
  assert.equal(ctx, 'Header:\n- [Pitfall] pitfall:n2: note 2\n\nHeader:\n- [DevOps / Guide] K2: norme 2');
  assert.deepEqual(provider.requests[0].mcpTools, [], 'triage has no tools');
});

test('triage failure falls back to the untriaged text; no token means nothing is called', async () => {
  const notes = Array.from({ length: 6 }, (_, i) => `- [Bug] bug:n${i}: x`);
  const { server, settings } = await fakeServer(notes, []);
  const ctx = await promptContext(settings, new FakeProvider(new Error('timeout')), { prompt: 'p' });
  assert.equal(ctx.split('\n').length, 7);
  assert.equal(await promptContext({ ...settings, serverToken: '' }, null, { prompt: 'p' }), '');
  server.close();
});

test('parseTriage and stripConsolidationNudge', () => {
  assert.deepEqual([...parseTriage('2, 5', 6)!], [2, 5]);
  assert.equal(parseTriage('none', 6)!.size, 0);
  assert.equal(parseTriage('I think all of them', 6), null);
  assert.equal(stripConsolidationNudge('RULES\n\nEpisodic memory: 3 episode(s) awaiting'), 'RULES');
  assert.equal(stripConsolidationNudge('RULES'), 'RULES');
});

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
