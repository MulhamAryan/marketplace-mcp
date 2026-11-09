import type { Db } from '../storage/db.js';
import { addRawEvent } from '../storage/events.js';
import { addPrompt, currentPromptNumber } from '../storage/prompts.js';
import { markSessionEnded, upsertSession } from '../storage/sessions.js';
import { addSummaryRequest } from '../storage/summaries.js';
import { projectFromCwd } from '../project.js';
import type { Settings } from '../settings.js';

/**
 * Worker API bodies (local capture only: episodes still reach the server through hook_capture).
 * The spool replays these same bodies, so routes and spool drain share one code path.
 */
export interface PromptBody {
  sessionId: string;
  cwd?: string;
  prompt: string;
}

export interface ObserveBody {
  sessionId: string;
  cwd?: string;
  event: string;
  toolName?: string;
  toolInput?: unknown;
  toolResponse?: unknown;
}

export interface SummaryBody {
  sessionId: string;
  cwd?: string;
  lastAssistantMessage?: string;
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
  return { promptNumber: addPrompt(db, sessionId, body.prompt) };
}

export function ingestObservation(db: Db, settings: Settings, body: ObserveBody): { stored: boolean; id?: number } {
  const sessionId = requireSession(body);
  if (!body.event) throw new BadRequest('event is required');
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
