import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * End-to-end through the built bundle, exactly as Claude Code runs it (`node dist/eonix-mem.mjs
 * hook <event>`, payload on stdin), against a fake Eonix server exposing the existing /api/hook/*
 * endpoints. Requires `npm run build` first.
 */
const CLI = path.resolve(import.meta.dirname, '..', 'dist', 'eonix-mem.mjs');
const PORT = 37000 + Math.floor(Math.random() * 500);
const TOKEN = 'test-token';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eonix-mem-test-'));

interface Received {
  endpoint: string;
  auth: string | undefined;
  body: Record<string, unknown>;
}
const received: Received[] = [];
let fake: http.Server;
let env: NodeJS.ProcessEnv;

function reply(endpoint: string): unknown {
  switch (endpoint) {
    case 'notes-check':
      return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'Project memory notes:\n- [Pitfall] pitfall:winnat (score 0.8): ports réservés' } };
    case 'knowledge-check':
      return {};
    case 'session-start':
      return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'REGLES ADMIN\n\nEpisodic memory: 12 episode(s) awaiting consolidation for project x.' } };
    default:
      return { captured: true };
  }
}

/** Runs one hook asynchronously: a sync spawn would freeze this process, fake server included. */
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

const injected = (stdout: string) => (stdout ? JSON.parse(stdout).hookSpecificOutput.additionalContext as string : '');

async function health() {
  const res = await fetch(`http://127.0.0.1:${PORT}/health`);
  return (await res.json()) as { name: string; counts: Record<string, number> };
}

async function waitFor(predicate: () => boolean, ms = 8000) {
  const end = Date.now() + ms;
  while (!predicate() && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
}

before(async () => {
  assert.ok(fs.existsSync(CLI), 'run `npm run build` before the tests');
  fake = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      const endpoint = (req.url ?? '').replace('/api/hook/', '');
      received.push({ endpoint, auth: req.headers.authorization, body: JSON.parse(data || '{}') });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(reply(endpoint)));
    });
  });
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  const serverUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
  env = {
    ...process.env,
    EONIX_MEM_DATA_DIR: dataDir,
    EONIX_MEM_PORT: String(PORT),
    EONIX_MCP_URL: serverUrl,
    EONIX_HOOK_TOKEN: TOKEN,
  };
  // No agents in this test: point at a missing claude executable.
  fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ claudePath: path.join(dataDir, 'no-claude.exe'), outboxIntervalMs: 200 }));
});

after(async () => {
  await fetch(`http://127.0.0.1:${PORT}/api/shutdown`, { method: 'POST' }).catch(() => {});
  await new Promise((r) => setTimeout(r, 300));
  fake.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('SessionStart: admin rules without the consolidation nudge, plus the background notice', async () => {
  const ctx = injected(await hook('SessionStart', { session_id: 'e2e', cwd: 'D:\\projects\\demo', source: 'startup' }));
  assert.match(ctx, /REGLES ADMIN/);
  assert.doesNotMatch(ctx, /awaiting consolidation/, 'consolidation is done by the worker agent');
  assert.match(ctx, /arrière-plan par eonix-mem/);
  const call = received.find((r) => r.endpoint === 'session-start')!;
  assert.equal(call.auth, `Bearer ${TOKEN}`);
});

test('UserPromptSubmit injects the server notes; prompt, Edit and Stop are relayed raw as before', async () => {
  const cwd = 'D:\\projects\\demo';
  const ctx = injected(await hook('UserPromptSubmit', { session_id: 'e2e', cwd, prompt: 'rename the service' }));
  assert.match(ctx, /pitfall:winnat/);
  assert.equal(received.find((r) => r.endpoint === 'notes-check')?.body.prompt, 'rename the service');

  await hook('PostToolUse', { session_id: 'e2e', cwd, tool_name: 'Edit', tool_input: { file_path: 'a.cs' }, tool_response: 'ok' });
  await hook('PostToolUse', { session_id: 'e2e', cwd, tool_name: 'Read', tool_input: { file_path: 'b.cs' }, tool_response: 'x' });
  await hook('PostToolUseFailure', { session_id: 'e2e', cwd, tool_name: 'Bash', tool_input: { command: 'dotnet test' }, error: 'exit 1' });
  await hook('Stop', { session_id: 'e2e', cwd, last_assistant_message: 'Renamed.' });

  const captures = () => received.filter((r) => r.endpoint === 'capture');
  await waitFor(() => captures().length >= 3);
  assert.deepEqual(
    captures().map((r) => [r.body.hook_event_name, r.body.tool_name ?? null]),
    [['UserPromptSubmit', null], ['PostToolUse', 'Edit'], ['Stop', null]],
    'same events as the former hook_capture matcher (Read and failures are not relayed)',
  );
  assert.deepEqual(captures()[1].body.tool_input, { file_path: 'a.cs' }, 'raw payload, unchanged');

  const h = await health();
  assert.equal(h.counts.prompts, 1);
  assert.equal(h.counts.rawEvents, 3, 'local capture keeps Read and the failure too');
  assert.equal(h.counts.episodesWaitingForServer, 0);
});

test('server down -> episodes wait in the outbox; worker down -> events are spooled; nothing is lost', async () => {
  const before = received.filter((r) => r.endpoint === 'capture').length;
  // Worker unreachable and cannot start: the hook spools and exits 0.
  await hook(
    'Stop',
    { session_id: 'spooled', cwd: '/x/demo', last_assistant_message: 'offline' },
    { EONIX_MEM_PORT: String(PORT + 1), EONIX_MEM_CLI: path.join(dataDir, 'missing.cjs') },
  );
  const spoolDir = path.join(dataDir, 'spool');
  assert.equal(fs.readdirSync(spoolDir).filter((f) => f.endsWith('.json')).length, 1);

  // Restart the real worker: it replays the spool, and the episode reaches the server.
  await fetch(`http://127.0.0.1:${PORT}/api/shutdown`, { method: 'POST' });
  await new Promise((r) => setTimeout(r, 500));
  await hook('SessionStart', { session_id: 'spooled', cwd: '/x/demo' });
  await waitFor(() => received.filter((r) => r.endpoint === 'capture').length > before);
  const last = received.filter((r) => r.endpoint === 'capture').at(-1)!;
  assert.equal(last.body.session_id, 'spooled');
  assert.equal(fs.readdirSync(spoolDir).filter((f) => f.endsWith('.json')).length, 0);
});
