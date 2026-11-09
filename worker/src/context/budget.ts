import { estimateTokens } from './tokens.js';

/** Room kept back so the closing "N hidden" notice always fits. */
const NOTICE_RESERVE_CHARS = 160;

/**
 * Accumulates context blocks until either the token budget or the character cap is reached.
 * A block that does not fit is refused whole: the context never ends on a half-written block.
 */
export class ContextBudget {
  private readonly blocks: string[] = [];
  private tokens = 0;
  private chars = 0;

  constructor(
    private readonly maxTokens: number,
    private readonly maxChars: number,
  ) {}

  /** Adds a block within the budget minus the notice reserve; `final` may use the reserve. */
  tryAdd(block: string, final = false): boolean {
    const reserveChars = final ? 0 : NOTICE_RESERVE_CHARS;
    const reserveTokens = final ? 0 : estimateTokens('x'.repeat(NOTICE_RESERVE_CHARS));
    const t = estimateTokens(block);
    const c = block.length + 1;
    if (this.tokens + t > this.maxTokens - reserveTokens || this.chars + c > this.maxChars - reserveChars) return false;
    this.blocks.push(block);
    this.tokens += t;
    this.chars += c;
    return true;
  }

  render(): string {
    return this.blocks.join('\n');
  }
}
