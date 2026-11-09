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
  /** Model used to compress a turn into observations. */
  compressionModel: string;
  /** Path to the `claude` executable driven by the Agent SDK; empty = look it up on PATH. */
  claudePath: string;
  /** How often the worker looks for turns ready to compress, in ms. */
  compressionIntervalMs: number;
  /** A turn with no Stop event is compressed anyway once its oldest event is this old, in ms. */
  orphanTurnAfterMs: number;
  /** Wait this long after a Stop before compressing its turn, so late async tool events join it, in ms. */
  turnSettleMs: number;
  /** Abort one compression call after this long, in ms. */
  compressionTimeoutMs: number;
  /** A turn that failed this many times is marked failed and never retried. */
  maxCompressionAttempts: number;
  /** Cap on the characters of one turn sent to the model; the oldest tool events are dropped first. */
  maxTurnInputChars: number;
  /** Observation types that leave the machine (pushed to the team server). All others stay local. */
  shareableTypes: string[];
  /** Token budget of the context injected at SessionStart (Claude Code caps it at 10,000 characters). */
  contextMaxTokens: number;
  /** Hard character cap of the injected context, kept under Claude Code's 10,000-character limit. */
  contextMaxChars: number;
  /** Number of recent session summaries shown at SessionStart. */
  contextSummaries: number;
  /** Number of most recent observations shown in full (the rest only in the index). */
  contextFullObservations: number;
  /** Maximum number of observations considered for the SessionStart index. */
  contextIndexObservations: number;
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
  compressionModel: 'claude-haiku-5-5',
  claudePath: '',
  compressionIntervalMs: 5000,
  orphanTurnAfterMs: 10 * 60 * 1000,
  turnSettleMs: 3000,
  compressionTimeoutMs: 120000,
  maxCompressionAttempts: 3,
  maxTurnInputChars: 60000,
  shareableTypes: ['Decision', 'BusinessRule', 'Pitfall', 'Documentation'],
  contextMaxTokens: 2200,
  contextMaxChars: 9500,
  contextSummaries: 3,
  contextFullObservations: 5,
  contextIndexObservations: 50,
};

/**
 * Set on the Claude Code process the worker spawns for compression. Our own hooks see it and do
 * nothing, so a compression session never records itself (belt and braces with settingSources: []).
 */
export const INTERNAL_ENV = 'EONIX_MEM_INTERNAL';

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
