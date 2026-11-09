import type { Db } from '../storage/db.js';
import type { Settings } from '../settings.js';
import { loadTurn, readyTurns, recordTurnFailure, saveCompressedTurn } from '../storage/turns.js';
import { buildTurnPrompt, SYSTEM_PROMPT } from './prompts.js';
import { parseTurnOutput } from './parser.js';
import type { CompressionProvider } from './provider.js';
import { log } from '../log.js';

/**
 * Background compression: hooks only store raw events; this loop turns each finished turn into
 * observations + a summary, one model call per turn, one turn at a time. Never blocks a hook.
 */
export class CompressionQueue {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly db: Db,
    private readonly settings: Settings,
    private readonly provider: CompressionProvider,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.runOnce(), this.settings.compressionIntervalMs);
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
          const userPrompt = buildTurnPrompt(
            {
              project: turn.project,
              prompt: turn.prompt,
              lastAssistantMessage: turn.lastAssistantMessage,
              events: turn.events.map((e) => ({
                event: e.event, toolName: e.tool_name, toolInput: e.tool_input, toolResponse: e.tool_response,
              })),
            },
            this.settings.maxTurnInputChars,
          );
          const output = await this.provider.complete(SYSTEM_PROMPT, userPrompt);
          const parsed = parseTurnOutput(output);
          const ids = saveCompressedTurn(this.db, turn, parsed, this.settings.shareableTypes);
          log('worker', `turn ${key.sessionId}#${key.promptNumber} compressed: ${ids.length} observation(s)${parsed.skip ? ' (skip)' : ''}`);
        } catch (err) {
          const gaveUp = recordTurnFailure(this.db, turn, this.settings.maxCompressionAttempts);
          log('worker', `turn ${key.sessionId}#${key.promptNumber} compression failed${gaveUp ? ' — giving up' : ''}`, err);
        }
        handled++;
      }
    } catch (err) {
      log('worker', 'compression loop failed', err);
    } finally {
      this.running = false;
    }
    return handled;
  }
}
