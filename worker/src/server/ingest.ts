import type { Db } from '../storage/db.js';
import { addRawEvent } from '../storage/events.js';
import { addPrompt, currentPromptNumber } from '../storage/prompts.js';
import { markSessionEnded, upsertSession } from '../storage/sessions.js';
import { addSummaryRequest } from '../storage/summaries.js';
import { enqueueOutbox } from '../storage/outbox.js';
import { projectFromCwd } from '../project.js';
import type { Settings } from '../settings.js';

/**
 * Worker API bodies. Each carries the raw Claude Code hook payload (`raw`), relayed unchanged to the
 * server's /api/hook/capture — the episodes the server receives are exactly those hook_capture sent.
 * The spool replays these same bodies, so routes and spool drain share one code path.
 */
export interface PromptBody {
  sessionId: string;
  cwd?: string;
  prompt: string;
  raw?: unknown;
}

export interface ObserveBody {
  sessionId: string;
  cwd?: string;
  event: string;
  toolName?: string;
  toolInput?: unknown;
  toolResponse?: unknown;
  raw?: unknown;
}

export interface SummaryBody {
  sessionId: string;
  cwd?: string;
  lastAssistantMessage?: string;
  raw?: unknown;
}

export type IngestRoute = 'prompt' | 'observe' | 'summary';

export class BadRequest extends Error {}

function requireSession(body: { sessionId?: string }): string {
  if (!body.sessionId || typeof body.sessionId !== 'string') throw new BadRequest('sessionId is required');
  return body.sessionId;
}

function serialize(value: unknown, max: number): string | null {
  if (value === undefined || value === null) return null;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]` : text;
}

export function ingestPrompt(db: Db, body: PromptBody): { promptNumber: number } {
  const sessionId = requireSession(body);
  if (typeof body.prompt !== 'string') throw new BadRequest('prompt is required');
  upsertSession(db, sessionId, projectFromCwd(body.cwd), body.cwd);
  if (body.raw) enqueueOutbox(db, 'capture', body.raw);
  return { promptNumber: addPrompt(db, sessionId, body.prompt) };
}

export function ingestObservation(db: Db, settings: Settings, body: ObserveBody): { stored: boolean; id?: number } {
  const sessionId = requireSession(body);
  if (!body.event) throw new BadRequest('event is required');

  // Same events as the former hook_capture matcher, relayed raw; the server keeps its own filtering.
  if (body.raw && body.event === 'PostToolUse' && body.toolName && settings.captureTools.includes(body.toolName)) {
    enqueueOutbox(db, 'capture', body.raw);
  }
  if (body.toolName && settings.skipTools.includes(body.toolName)) return { stored: false };

  const project = projectFromCwd(body.cwd);
  upsertSession(db, sessionId, project, body.cwd);
  const id = addRawEvent(db, {
    sessionId,
    project,
    promptNumber: currentPromptNumber(db, sessionId),
    event: body.event,
    toolName: body.toolName ?? null,
    toolInput: serialize(body.toolInput, settings.maxToolInputChars),
    toolResponse: serialize(body.toolResponse, settings.maxToolResponseChars),
  });
  return { stored: true, id };
}

export function ingestSummary(db: Db, body: SummaryBody): { id: number } {
  const sessionId = requireSession(body);
  const project = projectFromCwd(body.cwd);
  upsertSession(db, sessionId, project, body.cwd);
  if (body.raw) enqueueOutbox(db, 'capture', body.raw);
  const id = addSummaryRequest(db, sessionId, project, currentPromptNumber(db, sessionId), body.lastAssistantMessage ?? null);
  markSessionEnded(db, sessionId);
  return { id };
}

export function ingest(db: Db, settings: Settings, route: IngestRoute, body: unknown): unknown {
  switch (route) {
    case 'prompt':
      return ingestPrompt(db, body as PromptBody);
    case 'observe':
      return ingestObservation(db, settings, body as ObserveBody);
    case 'summary':
      return ingestSummary(db, body as SummaryBody);
  }
}
