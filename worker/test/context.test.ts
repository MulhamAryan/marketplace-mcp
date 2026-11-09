import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, type Db } from '../src/storage/db.js';
import { ingestPrompt, ingestSummary } from '../src/server/ingest.js';
import { loadTurn, saveCompressedTurn } from '../src/storage/turns.js';
import { buildContext } from '../src/context/builder.js';
import { searchObservations, observationsByIds } from '../src/storage/observations.js';
import { estimateTokens } from '../src/context/tokens.js';
import { DEFAULT_SETTINGS } from '../src/settings.js';
import type { ParsedObservation } from '../src/compression/parser.js';

const settings = { ...DEFAULT_SETTINGS };
const CWD = 'D:/projects/demo';

/** Seeds n compressed turns, one observation each, through the real storage path. */
function seed(db: Db, n: number, narrative = 'Une explication courte.') {
  for (let i = 1; i <= n; i++) {
    const sessionId = `s${i}`;
    ingestPrompt(db, { sessionId, cwd: CWD, prompt: `demande ${i}` });
    ingestSummary(db, { sessionId, cwd: CWD, lastAssistantMessage: 'ok' });
    const turn = loadTurn(db, { sessionId, promptNumber: 1 })!;
    // Odd turns: a team note the agent pushed (mirrored locally). Even turns: a local Change.
    const pushed = i % 2 ? [{ type: 'Pitfall', target: `Observation numéro ${i}`, content: `${narrative} winnat` }] : [];
    const obs: ParsedObservation[] = i % 2 ? [] : [{
      type: 'Change', title: `Observation numéro ${i}`, subtitle: null,
      narrative, facts: [`fait ${i}`], concepts: ['winnat'], files: ['a.ts'],
    }];
    saveCompressedTurn(db, turn, {
      skip: false, observations: obs,
      summary: { request: `demande ${i}`, investigated: null, learned: null, completed: `fait ${i}`, nextSteps: null },
    }, pushed);
  }
}

test('no compressed memory for the project -> nothing injected', () => {
  const db = openDb(':memory:');
  assert.equal(buildContext(db, settings, CWD, 'cli.mjs'), '');
  seed(db, 2);
  assert.equal(buildContext(db, settings, 'D:/projects/other', 'cli.mjs'), '');
});

test('context: summaries, recent observations in full, older ones in the index with their cost', () => {
  const db = openDb(':memory:');
  seed(db, 12);
  const ctx = buildContext(db, settings, CWD, 'cli.mjs');
  assert.match(ctx, /# Mémoire locale \(eonix-mem\) — demo/);
  assert.match(ctx, /show <id>/);
  assert.match(ctx, /## Dernières sessions\n- \d{4}-\d\d-\d\d — demande 12 → fait 12/);
  assert.match(ctx, /### #12 \[Change\] Observation numéro 12/);
  assert.match(ctx, /### #8 \[Change\]/);
  assert.doesNotMatch(ctx, /### #7 /, 'only contextFullObservations=5 in full');
  assert.match(ctx, /- #7 \d{4}-\d\d-\d\d \[Pitfall\] Observation numéro 7 \(~\d+ tok\)/);
  assert.match(ctx, /partagée équipe/, 'team note written on the server');
});

test('context never exceeds the token budget or the character cap, and says what it hid', () => {
  const db = openDb(':memory:');
  seed(db, 50, 'x'.repeat(600));
  const tight = { ...settings, contextMaxTokens: 600, contextMaxChars: 9500 };
  const ctx = buildContext(db, tight, CWD, 'cli.mjs');
  assert.ok(estimateTokens(ctx) <= 600, `~${estimateTokens(ctx)} tokens`);
  assert.match(ctx, /non affichée/);

  const wide = buildContext(db, { ...settings, contextMaxTokens: 100000 }, CWD, 'cli.mjs');
  assert.ok(wide.length <= settings.contextMaxChars, 'Claude Code 10k-char cap respected');
});

test('search and show: FTS over observations, user input never parsed as FTS syntax', () => {
  const db = openDb(':memory:');
  seed(db, 3);
  assert.equal(searchObservations(db, 'winnat', 'demo', 10).length, 3);
  assert.equal(searchObservations(db, 'numéro 2', 'demo', 10)[0].id, 2);
  assert.equal(searchObservations(db, 'winnat', 'other', 10).length, 0);
  assert.doesNotThrow(() => searchObservations(db, 'a" OR NEAR(', undefined, 10));
  assert.deepEqual(observationsByIds(db, [1, 3]).map((o) => o.id), [1, 3]);
});
