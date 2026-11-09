import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, type Db } from '../src/storage/db.js';
import { ingestObservation, ingestPrompt, ingestSummary } from '../src/server/ingest.js';
import { parseTurnOutput } from '../src/compression/parser.js';
import { buildTurnPrompt } from '../src/compression/prompts.js';
import { CompressionQueue } from '../src/compression/queue.js';
import type { CompressionProvider } from '../src/compression/provider.js';
import { counts } from '../src/storage/stats.js';
import { DEFAULT_SETTINGS } from '../src/settings.js';

const settings = { ...DEFAULT_SETTINGS, turnSettleMs: 0 };

const PITFALL_XML = `
<observation type="Pitfall">
  <title>Port 58699 réservé par WinNAT</title>
  <narrative>Le bind Caddy échoue car le port est dans une plage exclue &amp; réservée.</narrative>
  <facts><fact>netsh int ipv4 show excludedportrange tcp</fact></facts>
  <concepts><concept>docker</concept></concepts>
  <files><file>deploy/.env</file></files>
</observation>
<observation type="Change"><title>WEB_PORT passé à 58800</title></observation>
<summary><request>corriger le build</request><completed>port changé</completed></summary>`;

class FakeProvider implements CompressionProvider {
  calls: string[] = [];
  constructor(private readonly reply: string | Error) {}
  async complete(_system: string, user: string): Promise<string> {
    this.calls.push(user);
    if (this.reply instanceof Error) throw this.reply;
    return this.reply;
  }
}

function seedTurn(db: Db, withStop = true) {
  ingestPrompt(db, { sessionId: 's1', cwd: '/p/demo', prompt: 'corrige le build' });
  ingestObservation(db, settings, {
    sessionId: 's1', cwd: '/p/demo', event: 'PostToolUseFailure', toolName: 'Bash',
    toolInput: { command: 'make up' }, toolResponse: { error: 'bind: forbidden 58699' },
  });
  if (withStop) ingestSummary(db, { sessionId: 's1', cwd: '/p/demo', lastAssistantMessage: 'Port changé en 58800.' });
}

test('parser: types, lists, entities; unknown type falls back to local Discovery', () => {
  const parsed = parseTurnOutput(PITFALL_XML + '<observation type="Hack"><title>x</title></observation>');
  assert.equal(parsed.observations.length, 3);
  assert.equal(parsed.observations[0].type, 'Pitfall');
  assert.match(parsed.observations[0].narrative!, /exclue & réservée/);
  assert.deepEqual(parsed.observations[0].files, ['deploy/.env']);
  assert.equal(parsed.observations[2].type, 'Discovery');
  assert.equal(parsed.summary?.request, 'corriger le build');
  assert.equal(parseTurnOutput('<skip/>').skip, true);
  assert.throws(() => parseTurnOutput('Sure! Here is a summary.'));
});

test('prompt builder drops the oldest tool events first and says so', () => {
  const events = Array.from({ length: 10 }, (_, i) => ({
    event: 'PostToolUse', toolName: 'Read', toolInput: `file${i}`, toolResponse: 'x'.repeat(500),
  }));
  const prompt = buildTurnPrompt({ project: 'demo', prompt: 'p', events, lastAssistantMessage: 'done' }, 2500);
  assert.match(prompt, /earlier tool call\(s\) omitted/);
  assert.match(prompt, /file9/);
  assert.doesNotMatch(prompt, /file0/);
  assert.match(prompt, /<claude_final_answer>/);
});

test('queue compresses a finished turn: shareable types queued for push, others local', async () => {
  const db = openDb(':memory:');
  seedTurn(db);
  const provider = new FakeProvider(PITFALL_XML);
  assert.equal(await new CompressionQueue(db, settings, provider).runOnce(), 1);

  assert.equal(provider.calls.length, 1);
  assert.match(provider.calls[0], /corrige le build/);
  assert.match(provider.calls[0], /forbidden 58699/);
  assert.match(provider.calls[0], /Port changé en 58800/);

  const c = counts(db);
  assert.equal(c.observations, 2);
  assert.equal(c.observationsToShare, 1, 'only the Pitfall leaves the machine');
  assert.equal(c.rawEventsPending, 0);
  assert.equal(c.summariesPending, 0);
  const fts = db.prepare(`SELECT rowid FROM observations_fts WHERE observations_fts MATCH 'WinNAT'`).all();
  assert.equal(fts.length, 1);
  assert.equal(await new CompressionQueue(db, settings, provider).runOnce(), 0, 'nothing left');
});

test('turn without Stop waits until it is orphaned', async () => {
  const db = openDb(':memory:');
  seedTurn(db, false);
  const provider = new FakeProvider('<skip/>');
  assert.equal(await new CompressionQueue(db, settings, provider).runOnce(), 0);
  assert.equal(await new CompressionQueue(db, { ...settings, orphanTurnAfterMs: -1000 }, provider).runOnce(), 1);
  assert.equal(counts(db).rawEventsPending, 0);
});

test('failures are retried, then the turn is marked failed', async () => {
  const db = openDb(':memory:');
  seedTurn(db);
  const queue = new CompressionQueue(db, { ...settings, maxCompressionAttempts: 2 }, new FakeProvider(new Error('boom')));
  await queue.runOnce();
  assert.equal(counts(db).summariesPending, 1, 'retried after first failure');
  await queue.runOnce();
  assert.equal(counts(db).summariesPending, 0);
  assert.equal(counts(db).rawEventsFailed, 1);
  assert.equal(counts(db).observations, 0);
});
