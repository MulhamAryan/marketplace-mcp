import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConsolidationJob, activeProjects } from '../src/compression/consolidation.js';
import { DistillQueue } from '../src/compression/queue.js';
import { sessionContext, BACKGROUND_NOTICE } from '../src/server/session-context.js';
import { openDb } from '../src/storage/db.js';
import { ingestPrompt, ingestSummary } from '../src/server/ingest.js';
import { DEFAULT_SETTINGS } from '../src/settings.js';
import type { AgentProvider, AgentRequest, AgentResult, AgentToolCall } from '../src/compression/provider.js';
import { FakeProvider } from './helpers.js';

const call = (tool: string): AgentToolCall => ({ tool, input: {}, ok: true, result: '{}' });

/** Answers each consolidation run with `marked[i]` clusters marked (one note per cluster), then 0. */
class BacklogProvider implements AgentProvider {
  requests: AgentRequest[] = [];
  constructor(private readonly marked: number[]) {}
  async run(req: AgentRequest): Promise<AgentResult> {
    const n = this.marked[this.requests.length] ?? 0;
    this.requests.push(req);
    const toolCalls = Array.from({ length: n }, () => [call('remember'), call('mark_consolidated')]).flat();
    return { text: `${n} note(s)`, toolCalls };
  }
}

const settings = { ...DEFAULT_SETTINGS, consolidationClustersPerRun: 2, consolidationDebounceMs: 20 };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('consolidation runs the existing loop with exactly its four tools', async () => {
  const db = openDb(':memory:');
  const provider = new FakeProvider({ text: '1 note', toolCalls: [call('remember'), call('mark_consolidated')] });
  const run = await new ConsolidationJob(db, settings, provider).runProject('gob');
  assert.deepEqual(run, { notes: 1, marked: 1 });
  assert.deepEqual(provider.requests[0].mcpTools, ['pending_consolidations', 'list_cibles', 'remember', 'mark_consolidated']);
  assert.match(provider.requests[0].systemPrompt, /project "gob"/);
  assert.match(provider.requests[0].systemPrompt, /at most 2 clusters/);
});

test('turns in quick succession share one debounced run', async () => {
  const db = openDb(':memory:');
  const provider = new BacklogProvider([1]);
  const job = new ConsolidationJob(db, settings, provider);
  job.request('gob');
  job.request('gob');
  job.request('gob');
  assert.equal(provider.requests.length, 0, 'nothing before the debounce delay');
  await wait(80);
  assert.equal(provider.requests.length, 1);
  job.stop();
});

test('a backlog drains run after run, and stops as soon as a run does not fill its batch', async () => {
  const db = openDb(':memory:');
  // Batch of 2: full, full, full, then 1 (backlog done) -> 4 runs, 7 notes, no 5th run.
  const provider = new BacklogProvider([2, 2, 2, 1, 2]);
  const job = new ConsolidationJob(db, settings, provider);
  job.request('skill-marketplace');
  await wait(100);
  assert.equal(provider.requests.length, 4);
  assert.ok(provider.requests.every((r) => /project "skill-marketplace"/.test(r.systemPrompt)));
  job.stop();
});

test('only noise left (nothing marked) -> one run, no loop', async () => {
  const db = openDb(':memory:');
  const provider = new BacklogProvider([0]);
  const job = new ConsolidationJob(db, settings, provider);
  job.request('hub');
  await wait(80);
  assert.equal(provider.requests.length, 1);
  job.stop();
});

test('each distilled turn requests the consolidation of its project', async () => {
  const db = openDb(':memory:');
  ingestPrompt(db, { sessionId: 's1', cwd: '/p/gob', prompt: 'x' });
  ingestSummary(db, { sessionId: 's1', cwd: '/p/gob', lastAssistantMessage: 'ok' });
  const requested: string[] = [];
  const distill = new DistillQueue(db, { ...settings, turnSettleMs: 0 }, new FakeProvider({ text: '<skip/>', toolCalls: [] }), (p) => requested.push(p));
  await distill.runOnce();
  assert.deepEqual(requested, ['gob']);
});

test('activeProjects lists projects with recent local sessions', () => {
  const db = openDb(':memory:');
  ingestPrompt(db, { sessionId: 's1', cwd: '/p/gob', prompt: 'x' });
  ingestPrompt(db, { sessionId: 's2', cwd: '/p/hub', prompt: 'y' });
  assert.deepEqual(activeProjects(db, 14), ['gob', 'hub']);
});

test('SessionStart context: background notice only when agents run, always within the character cap', () => {
  const db = openDb(':memory:');
  assert.equal(sessionContext(db, DEFAULT_SETTINGS, '/p/demo', false), '', 'no agents, no memory: nothing');
  const ctx = sessionContext(db, DEFAULT_SETTINGS, '/p/demo', true);
  assert.equal(ctx, BACKGROUND_NOTICE);
  assert.match(ctx, /même si un rappel te le propose/, 'answers the consolidation nudge of hook_consolidation_check');
  assert.ok(ctx.length <= DEFAULT_SETTINGS.contextMaxChars);
});
