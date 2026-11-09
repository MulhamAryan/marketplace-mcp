import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * End-to-end through the built bundle, exactly as Claude Code runs it: `node dist/eonix-mem.mjs
 * hook <event>` with the hook payload on stdin. Agents are off here (no claude executable), so
 * nothing ever reaches the Eonix server. Requires `npm run build` first.
 */
const CLI = path.resolve(import.meta.dirname, '..', 'dist', 'eonix-mem.mjs');
const PORT = 37000 + Math.floor(Math.random() * 500);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eonix-mem-test-'));
const env = { ...process.env, EONIX_MEM_DATA_DIR: dataDir, EONIX_MEM_PORT: String(PORT) };

/** Runs one hook asynchronously and resolves with its stdout; rejects on a non-zero exit. */
function hook(event: string, payload: object, extraEnv: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--no-warnings', CLI, 'hook', event], { env: { ...env, ...extraEnv } });
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += d));
    const timer = setTimeout(() => child.kill(), 30000);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`hook ${event} exit code ${code}`));
    });
    child.stdin.end(JSON.stringify({ hook_event_name: event, ...payload }));
  });
}

async function health() {
  const res = await fetch(`http://127.0.0.1:${PORT}/health`);
  return (await res.json()) as { name: string; agents: string; counts: Record<string, number> };
}

before(() => {
  assert.ok(fs.existsSync(CLI), 'run `npm run build` before the tests');
  fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ claudePath: path.join(dataDir, 'no-claude.exe') }));
});

after(async () => {
  await fetch(`http://127.0.0.1:${PORT}/api/shutdown`, { method: 'POST' }).catch(() => {});
  await new Promise((r) => setTimeout(r, 300));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('first hook starts the worker on demand, then the turn is captured locally', async () => {
  const cwd = 'D:\\projects\\demo';
  assert.equal(await hook('SessionStart', { session_id: 'e2e', cwd }), '', 'no memory and no agents -> nothing injected');

  assert.equal(await hook('UserPromptSubmit', { session_id: 'e2e', cwd, prompt: 'rename the service' }), '', 'notes come from hook_notes_check, not from the worker');
  await hook('PostToolUse', { session_id: 'e2e', cwd, tool_name: 'Edit', tool_input: { file_path: 'a.cs' }, tool_response: 'ok' });
  await hook('PostToolUseFailure', { session_id: 'e2e', cwd, tool_name: 'Bash', tool_input: { command: 'dotnet test' }, error: 'exit 1' });
  await hook('PostToolUse', { session_id: 'e2e', cwd, tool_name: 'TodoWrite', tool_input: {} });
  await hook('Stop', { session_id: 'e2e', cwd, last_assistant_message: 'Renamed.' });

  const h = await health();
  assert.equal(h.name, 'AI Eonix Memory');
  assert.match(h.agents, /^off/);
  assert.equal(h.counts.sessions, 1);
  assert.equal(h.counts.prompts, 1);
  assert.equal(h.counts.rawEvents, 2, 'TodoWrite is skip-listed');
  assert.equal(h.counts.summaries, 1);
});

test('unreachable worker -> event is spooled, then replayed when the worker comes back', async () => {
  await hook(
    'UserPromptSubmit',
    { session_id: 'spooled', cwd: '/x/demo', prompt: 'offline prompt' },
    { EONIX_MEM_PORT: String(PORT + 1), EONIX_MEM_CLI: path.join(dataDir, 'missing.cjs') },
  );
  const spoolDir = path.join(dataDir, 'spool');
  assert.equal(fs.readdirSync(spoolDir).filter((f) => f.endsWith('.json')).length, 1);

  await fetch(`http://127.0.0.1:${PORT}/api/shutdown`, { method: 'POST' });
  await new Promise((r) => setTimeout(r, 500));
  await hook('SessionStart', { session_id: 'spooled', cwd: '/x/demo' });

  const h = await health();
  assert.equal(h.counts.prompts, 2, 'spooled prompt replayed');
  assert.equal(fs.readdirSync(spoolDir).filter((f) => f.endsWith('.json')).length, 0);
});

test('inside an agent session (EONIX_MEM_INTERNAL) hooks record nothing', async () => {
  const before = (await health()).counts.prompts;
  await hook('UserPromptSubmit', { session_id: 'agent', cwd: '/x/demo', prompt: 'agent prompt' }, { EONIX_MEM_INTERNAL: '1' });
  assert.equal((await health()).counts.prompts, before);
});
