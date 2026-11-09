import type { Db } from '../storage/db.js';
import type { Settings } from '../settings.js';
import { loadTurn, readyTurns, recordTurnFailure, saveCompressedTurn, type PushedNote } from '../storage/turns.js';
import { buildTurnPrompt, distillSystemPrompt, NOTE_TYPES } from './prompts.js';
import { parseTurnOutput } from './parser.js';
import type { AgentProvider, AgentToolCall } from './provider.js';
import { log } from '../log.js';

/** Team notes actually written on the server: successful remember calls with a valid type and target. */
export function pushedNotes(calls: AgentToolCall[]): PushedNote[] {
  return calls
    .filter((c) => c.tool === 'remember' && c.ok)
    .map((c) => ({ type: String(c.input.type ?? ''), target: String(c.input.target ?? ''), content: String(c.input.content ?? '') }))
    .filter((n) => (NOTE_TYPES as readonly string[]).includes(n.type) && n.target);
}

/**
 * Background distill: hooks only store raw events; after each finished turn this loop hands the turn
 * to an agent that applies the team's distill rules (list_cibles then remember, on the server) and
 * writes the local turn summary. One agent run per turn, one turn at a time. Never blocks a hook.
 */
export class DistillQueue {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly db: Db,
    private readonly settings: Settings,
    private readonly provider: AgentProvider,
    /** Called with the project of each distilled turn (triggers its consolidation). */
    private readonly onTurnDistilled: (project: string) => void = () => {},
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.runOnce(), this.settings.distillIntervalMs);
    void this.runOnce();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Processes every ready turn; overlapping ticks are skipped. Returns the number of turns handled. */
  async runOnce(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let handled = 0;
    try {
      const { orphanTurnAfterMs, turnSettleMs } = this.settings;
      for (const key of readyTurns(this.db, orphanTurnAfterMs, turnSettleMs, 20)) {
        const turn = loadTurn(this.db, key);
        if (!turn) continue;
        try {
          const result = await this.provider.run({
            systemPrompt: distillSystemPrompt(turn.project),
            prompt: buildTurnPrompt(
              {
                project: turn.project,
                prompt: turn.prompt,
                lastAssistantMessage: turn.lastAssistantMessage,
                events: turn.events.map((e) => ({
                  event: e.event, toolName: e.tool_name, toolInput: e.tool_input, toolResponse: e.tool_response,
                })),
              },
              this.settings.maxTurnInputChars,
            ),
            mcpTools: ['list_cibles', 'remember'],
            maxTurns: 8,
            timeoutMs: this.settings.distillTimeoutMs,
          });
          const notes = pushedNotes(result.toolCalls);
          let parsed;
          try {
            parsed = parseTurnOutput(result.text);
          } catch (err) {
            // Notes already written on the server must not be written again by a retry: close the
            // turn without a local summary instead of failing it.
            if (notes.length === 0) throw err;
            parsed = { skip: false, observations: [], summary: null };
          }
          saveCompressedTurn(this.db, turn, parsed, notes);
          const written = notes.map((n) => `${n.type} ${n.target}`).join(', ') || 'none';
          log('worker', `turn ${key.sessionId}#${key.promptNumber} distilled — team notes: ${written}`);
          this.onTurnDistilled(turn.project);
        } catch (err) {
          const gaveUp = recordTurnFailure(this.db, turn, this.settings.maxDistillAttempts);
          log('worker', `turn ${key.sessionId}#${key.promptNumber} distill failed${gaveUp ? ' — giving up' : ''}`, err);
        }
        handled++;
      }
    } catch (err) {
      log('worker', 'distill loop failed', err);
    } finally {
      this.running = false;
    }
    return handled;
  }
}
