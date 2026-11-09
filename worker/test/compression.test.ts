import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, type Db } from '../src/storage/db.js';
import { ingestObservation, ingestPrompt, ingestSummary } from '../src/server/ingest.js';
import { parseTurnOutput } from '../src/compression/parser.js';
import { buildTurnPrompt } from '../src/compression/prompts.js';
import { DistillQueue, pushedNotes } from '../src/compression/queue.js';
import type { AgentToolCall } from '../src/compression/provider.js';
import { FakeProvider } from './helpers.js';
import { counts } from '../src/storage/stats.js';
import { DEFAULT_SETTINGS } from '../src/settings.js';

const settings = { ...DEFAULT_SETTINGS, turnSettleMs: 0 };

const SUMMARY_XML = `<observation type="Change"><title>WEB_PORT passé à 58800</title><files><file>deploy/.env</file></files></observation>
<summary><request>corriger le build</request><completed>port changé</completed></summary>`;

const REMEMBER: AgentToolCall = {
  tool: 'remember',
  input: { project: 'demo', type: 'Pitfall', target: 'pitfall:winnat-reserved-ports', scope: 'Shared', content: 'WinNAT réserve des plages.' },
  ok: true,
  result: '{"Id":"x"}',
};

function seedTurn(db: Db, withStop = true) {
  ingestPrompt(db, { sessionId: 's1', cwd: '/p/demo', prompt: 'corrige le build' });
  ingestObservation(db, settings, {
    sessionId: 's1', cwd: '/p/demo', event: 'PostToolUseFailure', toolName: 'Bash',
    toolInput: { command: 'make up' }, toolResponse: { error: 'bind: forbidden 58699' },
  });
  if (withStop) ingestSummary(db, { sessionId: 's1', cwd: '/p/demo', lastAssistantMessage: 'Port changé en 58800.' });
}

test('parser keeps only local types; anything else in the XML becomes Discovery, never a team note', () => {
  const parsed = parseTurnOutput(SUMMARY_XML + '<observation type="Pitfall"><title>x</title></observation>');
  assert.deepEqual(parsed.observations.map((o) => o.type), ['Change', 'Discovery']);
  assert.equal(parsed.summary?.request, 'corriger le build');
  assert.equal(parseTurnOutput('<skip/>').skip, true);
  assert.throws(() => parseTurnOutput('Sure! Here is a summary.'));
});

test('pushedNotes keeps only successful remember calls with a team note type and a target', () => {
  const calls: AgentToolCall[] = [
    REMEMBER,
    { ...REMEMBER, ok: false },
    { ...REMEMBER, input: { ...REMEMBER.input, type: 'Change' } },
    { tool: 'list_cibles', input: {}, ok: true, result: '[]' },
  ];
  assert.deepEqual(pushedNotes(calls), [{ type: 'Pitfall', target: 'pitfall:winnat-reserved-ports', content: 'WinNAT réserve des plages.' }]);
});

test('prompt builder drops the oldest tool events first and says so', () => {
  const events = Array.from({ length: 10 }, (_, i) => ({
    event: 'PostToolUse', toolName: 'Read', toolInput: `file${i}`, toolResponse: 'x'.repeat(500),
  }));
  const prompt = buildTurnPrompt({ project: 'demo', prompt: 'p', events, lastAssistantMessage: 'done' }, 2500);
  assert.match(prompt, /earlier tool call\(s\) omitted/);
  assert.match(prompt, /file9/);
  assert.doesNotMatch(prompt, /file0/);
});

test('distill: the agent gets the turn and only list_cibles + remember; notes it wrote are mirrored locally', async () => {
  const db = openDb(':memory:');
  seedTurn(db);
  const provider = new FakeProvider({ text: SUMMARY_XML, toolCalls: [REMEMBER] });
  assert.equal(await new DistillQueue(db, settings, provider).runOnce(), 1);

  const [req] = provider.requests;
  assert.deepEqual(req.mcpTools, ['list_cibles', 'remember']);
  assert.match(req.systemPrompt, /by default, remember NOTHING/);
  assert.match(req.systemPrompt, /project "demo"/);
  assert.match(req.prompt, /forbidden 58699/);
  assert.match(req.prompt, /Port changé en 58800/);

  const c = counts(db);
  assert.equal(c.teamNotesWritten, 1);
  assert.equal(c.observations, 2, 'mirror of the team note + local Change');
  assert.equal(c.rawEventsPending, 0);
  assert.equal(c.summariesPending, 0);
  const row = db.prepare(`SELECT type, target, share_status FROM observations WHERE share_status = 'pushed'`).get() as Record<string, string>;
  assert.deepEqual({ ...row }, { type: 'Pitfall', target: 'pitfall:winnat-reserved-ports', share_status: 'pushed' });
});

test('a note already written is never written twice: bad XML after a remember closes the turn', async () => {
  const db = openDb(':memory:');
  seedTurn(db);
  await new DistillQueue(db, settings, new FakeProvider({ text: 'oops', toolCalls: [REMEMBER] })).runOnce();
  assert.equal(counts(db).summariesPending, 0);
  assert.equal(counts(db).teamNotesWritten, 1);
});

test('turn without Stop waits until it is orphaned', async () => {
  const db = openDb(':memory:');
  seedTurn(db, false);
  const provider = new FakeProvider({ text: '<skip/>', toolCalls: [] });
  assert.equal(await new DistillQueue(db, settings, provider).runOnce(), 0);
  assert.equal(await new DistillQueue(db, { ...settings, orphanTurnAfterMs: -1000 }, provider).runOnce(), 1);
  assert.equal(counts(db).rawEventsPending, 0);
});

test('failures are retried, then the turn is marked failed', async () => {
  const db = openDb(':memory:');
  seedTurn(db);
  const queue = new DistillQueue(db, { ...settings, maxDistillAttempts: 2 }, new FakeProvider(new Error('boom')));
  await queue.runOnce();
  assert.equal(counts(db).summariesPending, 1, 'retried after first failure');
  await queue.runOnce();
  assert.equal(counts(db).summariesPending, 0);
  assert.equal(counts(db).rawEventsFailed, 1);
});
