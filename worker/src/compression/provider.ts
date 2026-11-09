import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { INTERNAL_ENV, type Settings } from '../settings.js';

/**
 * Prefix of the Eonix MCP tools in an agent session. The agent loads this plugin, so it reaches the
 * marketplace server exactly like the developer's session does: through the plugin's OAuth connector
 * (plugin:eonix-mcp:marketplace), reusing the login Claude Code already holds. No token to distribute.
 */
export const EONIX_TOOL_PREFIX = 'mcp__plugin_eonix-mcp_marketplace__';

export interface AgentRequest {
  systemPrompt: string;
  prompt: string;
  /** Eonix MCP tools the agent may call (bare names, e.g. 'remember'). Empty = no tools at all. */
  mcpTools: string[];
  maxTurns: number;
  timeoutMs: number;
}

export interface AgentToolCall {
  /** Bare tool name, e.g. 'remember'. */
  tool: string;
  input: Record<string, unknown>;
  ok: boolean;
  /** Text of the tool result (e.g. remember's JSON with the note Id). */
  result: string;
}

export interface AgentResult {
  text: string;
  toolCalls: AgentToolCall[];
}

/** One background agent run. Abstracted so the queues are testable without a model or a server. */
export interface AgentProvider {
  run(req: AgentRequest): Promise<AgentResult>;
}

/**
 * Finds the developer's installed `claude` executable. The Agent SDK's own bundled binary is a
 * ~330 MB per-platform npm package, too big to ship in the plugin, so we drive the one already
 * installed (same login, same subscription).
 */
export function resolveClaudePath(settings: Settings): string | null {
  if (settings.claudePath) return fs.existsSync(settings.claudePath) ? settings.claudePath : null;
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const out = execFileSync(cmd, ['claude'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    const candidates = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    // On Windows `where` also lists the npm .cmd shim; the SDK needs a real executable.
    return candidates.find((c) => !/\.(cmd|bat|ps1)$/i.test(c)) ?? null;
  } catch {
    return null;
  }
}

/**
 * Root of this plugin (the folder holding .claude-plugin/ and .mcp.json): settings.pluginRoot, else
 * CLAUDE_PLUGIN_ROOT inherited from the hook that spawned the worker, else derived from the bundle
 * path (<root>/worker/dist/eonix-mem.mjs).
 */
export function resolvePluginRoot(settings: Settings): string | null {
  const candidates = [
    settings.pluginRoot,
    process.env.CLAUDE_PLUGIN_ROOT,
    process.argv[1] ? path.resolve(path.dirname(process.argv[1]), '..', '..') : '',
  ];
  return candidates.find((c) => c && fs.existsSync(path.join(c, '.mcp.json'))) ?? null;
}

const textOf = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((b) => (b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text) : '')).join('')
      : '';

/**
 * Claude Agent SDK provider: runs the installed Claude Code headless with the developer's own login.
 * Isolated from every local setting; loads only this plugin, for its OAuth MCP connector, with ALL
 * hooks disabled — the plugin's own hooks (hook_capture, notes check, eonix-mem) must never run in an
 * agent session, or it would record itself. The only tools it can call are the listed Eonix MCP
 * tools; anything else is refused (permission mode dontAsk).
 */
export class AgentSdkProvider implements AgentProvider {
  constructor(
    private readonly settings: Settings,
    private readonly claudePath: string,
    private readonly pluginRoot: string | null,
  ) {}

  async run(req: AgentRequest): Promise<AgentResult> {
    if (req.mcpTools.length > 0 && !this.pluginRoot) throw new Error('agent needs the Eonix plugin root, not found');
    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), req.timeoutMs);
    const pending = new Map<string, { tool: string; input: Record<string, unknown> }>();
    const toolCalls: AgentToolCall[] = [];
    try {
      const q = query({
        prompt: req.prompt,
        options: {
          model: this.settings.agentModel,
          systemPrompt: req.systemPrompt,
          tools: [],
          maxTurns: req.maxTurns,
          settingSources: [],
          settings: { disableAllHooks: true },
          plugins: req.mcpTools.length > 0 && this.pluginRoot ? [{ type: 'local', path: this.pluginRoot }] : [],
          allowedTools: req.mcpTools.map((t) => `${EONIX_TOOL_PREFIX}${t}`),
          permissionMode: 'dontAsk',
          persistSession: false,
          pathToClaudeCodeExecutable: this.claudePath,
          env: { ...process.env, [INTERNAL_ENV]: '1', CLAUDE_AGENT_SDK_CLIENT_APP: 'eonix-mem' },
          abortController,
        },
      });
      for await (const message of q) {
        if (message.type === 'assistant') {
          for (const block of message.message.content) {
            if (block.type === 'tool_use' && block.name.startsWith(EONIX_TOOL_PREFIX)) {
              pending.set(block.id, {
                tool: block.name.slice(EONIX_TOOL_PREFIX.length),
                input: (block.input ?? {}) as Record<string, unknown>,
              });
            }
          }
        } else if (message.type === 'user' && Array.isArray(message.message.content)) {
          for (const block of message.message.content) {
            if (block.type !== 'tool_result') continue;
            const call = pending.get(block.tool_use_id);
            if (!call) continue;
            pending.delete(block.tool_use_id);
            toolCalls.push({ ...call, ok: !block.is_error, result: textOf(block.content) });
          }
        } else if (message.type === 'result') {
          if (message.subtype === 'success' && !message.is_error) return { text: message.result, toolCalls };
          throw new Error(`agent run ended with ${message.subtype}`);
        }
      }
      throw new Error('agent run returned no result');
    } finally {
      clearTimeout(timer);
    }
  }
}
