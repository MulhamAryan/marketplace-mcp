import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * End-to-end through the built bundle, exactly as Claude Code runs it:
 * `node dist/eonix-mem.cjs hook <event>` with the hook payload on stdin.
 * Requires `npm run build` first.
 */
const CLI = path.resolve(import.meta.dirname, '..', 'dist', 'eonix-mem.cjs');
const PORT = 37000 + Math.floor(Math.random() * 500);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eonix-mem-test-'));
const env = { ...process.env, EONIX_MEM_DATA_DIR: dataDir, EONIX_MEM_PORT: String(PORT) };

function hook(event: string, payload: object, extraEnv: Record<string, string> = {}) {
  const res = spawnSync(process.execPath, ['--no-warnings', CLI, 'hook', event], {
    input: JSON.stringify(payload),
    env: { ...env, ...extraEnv },
    encoding: 'utf8',
    timeout: 20000,
  });
  assert.equal(res.status, 0, `hook ${event} exit code`);
  return res.stdout;
}

async function health() {
  const res = await fetch(`http://127.0.0.1:${PORT}/health`);
  return (await res.json()) as { name: string; counts: Record<string, number> };
}

before(() => assert.ok(fs.existsSync(CLI), 'run `npm run build` before the tests'));

after(async () => {
  await fetch(`http://127.0.0.1:${PORT}/api/shutdown`, { method: 'POST' }).catch(() => {});
  await new Promise((r) => setTimeout(r, 300));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('first hook starts the worker on demand, then events are captured', async () => {
  const cwd = 'D:\\projects\\demo';
  const out = hook('SessionStart', { session_id: 'e2e', cwd, hook_event_name: 'SessionStart' });
  assert.equal(out, '', 'no memory yet -> nothing injected');

  hook('UserPromptSubmit', { session_id: 'e2e', cwd, prompt: 'rename the service' });
  hook('PostToolUse', { session_id: 'e2e', cwd, tool_name: 'Edit', tool_input: { file_path: 'a.cs' }, tool_response: 'ok' });
  hook('PostToolUseFailure', { session_id: 'e2e', cwd, tool_name: 'Bash', tool_input: { command: 'dotnet test' }, error: 'exit 1' });
  hook('PostToolUse', { session_id: 'e2e', cwd, tool_name: 'TodoWrite', tool_input: {} });
  hook('Stop', { session_id: 'e2e', cwd, last_assistant_message: 'Renamed.' });

  const h = await health();
  assert.equal(h.name, 'eonix-mem');
  assert.equal(h.counts.sessions, 1);
  assert.equal(h.counts.prompts, 1);
  assert.equal(h.counts.rawEvents, 2, 'TodoWrite is skip-listed');
  assert.equal(h.counts.summaries, 1);
});

test('unreachable worker -> event is spooled, then drained when the worker comes back', async () => {
  // Point at a port nobody listens on and a CLI that cannot start: the hook must spool, exit 0, fast.
  const deadPort = String(PORT + 1);
  hook(
    'UserPromptSubmit',
    { session_id: 'spooled', cwd: '/x/demo', prompt: 'offline prompt' },
    { EONIX_MEM_PORT: deadPort, EONIX_MEM_CLI: path.join(dataDir, 'missing.cjs') },
  );
  const spoolDir = path.join(dataDir, 'spool');
  assert.equal(fs.readdirSync(spoolDir).filter((f) => f.endsWith('.json')).length, 1);

  // Restart the real worker: it drains the spool at startup.
  await fetch(`http://127.0.0.1:${PORT}/api/shutdown`, { method: 'POST' });
  await new Promise((r) => setTimeout(r, 500));
  hook('SessionStart', { session_id: 'spooled', cwd: '/x/demo' });

  const h = await health();
  assert.equal(h.counts.prompts, 2, 'spooled prompt replayed');
  assert.equal(fs.readdirSync(spoolDir).filter((f) => f.endsWith('.json')).length, 0);
});
