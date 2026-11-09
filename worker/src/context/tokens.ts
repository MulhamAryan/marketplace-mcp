/**
 * Cheap token estimate (~4 characters per token for mixed French/English/code). Only used to
 * budget the injected context and to show its cost; never for billing.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
