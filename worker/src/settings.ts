import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Every tuning value lives here, overridable in ~/.eonix-mem/settings.json — never hard-coded at call sites. */
export interface Settings {
  /** Loopback port of the local worker. */
  port: number;
  /** Timeout of a hook -> worker HTTP call, in ms. A hook must never block Claude Code. */
  hookTimeoutMs: number;
  /** Timeout of the UserPromptSubmit hook -> worker call, which waits for notes/knowledge, in ms. */
  promptHookTimeoutMs: number;
  /** How long a hook waits for a freshly spawned worker to answer /health, in ms. */
  startupWaitMs: number;
  /** Max wait for the hook payload on stdin, in ms. */
  stdinTimeoutMs: number;
  /** How often the worker replays the spool written while it was down, in ms. */
  spoolDrainIntervalMs: number;
  /** Tool responses longer than this are truncated before local storage. */
  maxToolResponseChars: number;
  /** Tool inputs longer than this are truncated before local storage. */
  maxToolInputChars: number;
  /** Tools whose PostToolUse events carry no useful memory and are not stored locally. */
  skipTools: string[];

  /** Eonix MCP server base URL; EONIX_MCP_URL (same variable as .mcp.json) wins when set. */
  serverUrl: string;
  /** Bearer token for the server; EONIX_HOOK_TOKEN wins when set. Same client_credentials token as the legacy HTTP hooks. */
  serverToken: string;
  /** Timeout of one worker -> server HTTP call, in ms. */
  serverTimeoutMs: number;
  /** Tools whose PostToolUse events are relayed to the server as episodes — the matcher hook_capture had. */
  captureTools: string[];
  /** How often the outbox of server episodes is flushed, in ms. */
  outboxIntervalMs: number;
  /** An outbox entry that failed this many times is dropped. */
  outboxMaxAttempts: number;

  /** Model of every background agent (distill, consolidation, note triage). */
  agentModel: string;
  /** Path to the `claude` executable driven by the Agent SDK; empty = look it up on PATH. */
  claudePath: string;
  /** How often the worker looks for finished turns to distill, in ms. */
  distillIntervalMs: number;
  /** A turn with no Stop event is distilled anyway once its oldest event is this old, in ms. */
  orphanTurnAfterMs: number;
  /** Wait this long after a Stop before distilling its turn, so late async tool events join it, in ms. */
  turnSettleMs: number;
  /** Abort one distill agent run after this long, in ms. */
  distillTimeoutMs: number;
  /** A turn that failed this many times is marked failed and never retried. */
  maxDistillAttempts: number;
  /** Cap on the characters of one turn sent to the distill agent; the oldest tool events are dropped first. */
  maxTurnInputChars: number;

  /** How often the consolidation agent runs, in ms. */
  consolidationIntervalMs: number;
  /** Clusters of episodes the consolidation agent handles per project and per run. */
  consolidationClustersPerRun: number;
  /** Abort one consolidation agent run after this long, in ms. */
  consolidationTimeoutMs: number;
  /** Only projects with a local session in this window are consolidated, in days. */
  consolidationActiveProjectDays: number;

  /** Above this many notes + norms for a prompt, the triage agent keeps only the relevant ones. */
  triageThreshold: number;
  /** Abort the triage agent after this long and inject the untriaged results, in ms. */
  triageTimeoutMs: number;

  /** Token budget of the local part of the SessionStart context. */
  contextMaxTokens: number;
  /** Hard character cap of the whole SessionStart context, under Claude Code's 10,000-character limit. */
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
  promptHookTimeoutMs: 15000,
  startupWaitMs: 4000,
  stdinTimeoutMs: 1000,
  spoolDrainIntervalMs: 30000,
  maxToolResponseChars: 20000,
  maxToolInputChars: 8000,
  skipTools: [
    'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'TaskStop',
    'ToolSearch', 'ListMcpResourcesTool', 'AskUserQuestion', 'ExitPlanMode', 'EnterPlanMode',
  ],

  serverUrl: 'https://mcp.marketplace.eonix.be',
  serverToken: '',
  serverTimeoutMs: 8000,
  captureTools: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash', 'PowerShell'],
  outboxIntervalMs: 3000,
  outboxMaxAttempts: 50,

  agentModel: 'claude-haiku-5-5',
  claudePath: '',
  distillIntervalMs: 5000,
  orphanTurnAfterMs: 10 * 60 * 1000,
  turnSettleMs: 3000,
  distillTimeoutMs: 180000,
  maxDistillAttempts: 3,
  maxTurnInputChars: 60000,

  consolidationIntervalMs: 30 * 60 * 1000,
  consolidationClustersPerRun: 3,
  consolidationTimeoutMs: 300000,
  consolidationActiveProjectDays: 14,

  triageThreshold: 5,
  triageTimeoutMs: 8000,

  contextMaxTokens: 1800,
  contextMaxChars: 9500,
  contextSummaries: 3,
  contextFullObservations: 5,
  contextIndexObservations: 50,
};

/**
 * Set on the Claude Code process the worker spawns for its agents. Our own hooks see it and do
 * nothing, so an agent session never records itself (belt and braces with settingSources: []).
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
  if (process.env.EONIX_MCP_URL) settings.serverUrl = process.env.EONIX_MCP_URL;
  if (process.env.EONIX_HOOK_TOKEN) settings.serverToken = process.env.EONIX_HOOK_TOKEN;
  settings.serverUrl = settings.serverUrl.replace(/\/+$/, '');
  return settings;
}

export function ensureDataDir(): void {
  fs.mkdirSync(dataDir(), { recursive: true });
}
