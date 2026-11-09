import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Every tuning value lives here, overridable in ~/.eonix-mem/settings.json — never hard-coded at call sites. */
export interface Settings {
  /** Loopback port of the local worker. */
  port: number;
  /** Timeout of a hook -> worker HTTP call, in ms. A hook must never block Claude Code. */
  hookTimeoutMs: number;
  /** How long a hook waits for a freshly spawned worker to answer /health, in ms. */
  startupWaitMs: number;
  /** Max wait for the hook payload on stdin, in ms. */
  stdinTimeoutMs: number;
  /** How often the worker replays the spool written while it was down, in ms. */
  spoolDrainIntervalMs: number;
  /** Tool responses longer than this are truncated before storage. */
  maxToolResponseChars: number;
  /** Tool inputs longer than this are truncated before storage. */
  maxToolInputChars: number;
  /** Tools whose PostToolUse events carry no useful memory and are dropped. */
  skipTools: string[];
}

export const DEFAULT_SETTINGS: Settings = {
  port: 37800,
  hookTimeoutMs: 1500,
  startupWaitMs: 4000,
  stdinTimeoutMs: 1000,
  spoolDrainIntervalMs: 30000,
  maxToolResponseChars: 20000,
  maxToolInputChars: 8000,
  skipTools: [
    'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'TaskStop',
    'ToolSearch', 'ListMcpResourcesTool', 'AskUserQuestion', 'ExitPlanMode', 'EnterPlanMode',
  ],
};

/** Data directory: EONIX_MEM_DATA_DIR (tests, multiple profiles) or ~/.eonix-mem. */
export function dataDir(): string {
  return process.env.EONIX_MEM_DATA_DIR || path.join(os.homedir(), '.eonix-mem');
}

export const paths = {
  settings: () => path.join(dataDir(), 'settings.json'),
  db: () => path.join(dataDir(), 'eonix-mem.db'),
  spool: () => path.join(dataDir(), 'spool'),
  logs: () => path.join(dataDir(), 'logs'),
  pid: () => path.join(dataDir(), 'worker.pid'),
};

export function loadSettings(): Settings {
  let user: Partial<Settings> = {};
  try {
    user = JSON.parse(fs.readFileSync(paths.settings(), 'utf8'));
  } catch {
    // Missing or invalid file: defaults apply.
  }
  const settings = { ...DEFAULT_SETTINGS, ...user };
  const envPort = Number(process.env.EONIX_MEM_PORT);
  if (Number.isInteger(envPort) && envPort > 0) settings.port = envPort;
  return settings;
}

export function ensureDataDir(): void {
  fs.mkdirSync(dataDir(), { recursive: true });
}
