import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { INTERNAL_ENV, type Settings } from '../settings.js';

/** One single-turn, tool-less LLM call. Abstracted so the queue is testable without a model. */
export interface CompressionProvider {
  complete(systemPrompt: string, userPrompt: string): Promise<string>;
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
 * Claude Agent SDK provider: runs the installed Claude Code headless with the developer's own
 * login, isolated from every local setting so none of our plugin hooks fire in the child session.
 */
export class AgentSdkProvider implements CompressionProvider {
  constructor(
    private readonly settings: Settings,
    private readonly claudePath: string,
  ) {}

  async complete(systemPrompt: string, userPrompt: string): Promise<string> {
    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), this.settings.compressionTimeoutMs);
    try {
      const q = query({
        prompt: userPrompt,
        options: {
          model: this.settings.compressionModel,
          systemPrompt,
          tools: [],
          maxTurns: 1,
          settingSources: [],
          strictMcpConfig: true,
          mcpServers: {},
          persistSession: false,
          pathToClaudeCodeExecutable: this.claudePath,
          env: { ...process.env, [INTERNAL_ENV]: '1', CLAUDE_AGENT_SDK_CLIENT_APP: 'eonix-mem' },
          abortController,
        },
      });
      for await (const message of q) {
        if (message.type !== 'result') continue;
        if (message.subtype === 'success' && !message.is_error) return message.result;
        throw new Error(`compression call ended with ${message.subtype}`);
      }
      throw new Error('compression call returned no result');
    } finally {
      clearTimeout(timer);
    }
  }
}
