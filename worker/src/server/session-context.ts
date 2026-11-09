import type { Db } from '../storage/db.js';
import type { Settings } from '../settings.js';
import { buildContext } from '../context/builder.js';
import { additionalContextOf, postHook, serverConfigured } from './remote.js';
import { log } from '../log.js';

/**
 * The server's session-start text ends with a nudge asking the session to consolidate episodes
 * itself. The worker's consolidation agent does that now, so the nudge is dropped to avoid doing
 * the work twice. Matches the exact sentence Program.cs appends.
 */
export function stripConsolidationNudge(text: string): string {
  const i = text.indexOf('\n\nEpisodic memory:');
  return (i >= 0 ? text.slice(0, i) : text).trim();
}

/** Tells the session that note-taking now happens in the background, so it is not done twice. */
export const BACKGROUND_NOTICE =
  "La mémoire d'équipe est alimentée automatiquement en arrière-plan par eonix-mem : à la fin de chaque " +
  'tour, un agent applique les règles de distillation (list_cibles puis remember) et consolide les épisodes ' +
  '(pending_consolidations). Ne le fais pas toi-même, sauf si le développeur le demande explicitement.';

/**
 * SessionStart context: team rules from /Admin (server session-start), the background notice, then
 * the local memory of the project within what is left of the character cap.
 */
export async function sessionContext(db: Db, settings: Settings, raw: Record<string, unknown>): Promise<string> {
  let rules = '';
  if (serverConfigured(settings)) {
    try {
      rules = stripConsolidationNudge(additionalContextOf(await postHook(settings, 'session-start', raw)));
    } catch (err) {
      log('worker', 'session-start failed', err);
    }
  }
  const head = [rules, BACKGROUND_NOTICE].filter(Boolean).join('\n\n');
  const room = settings.contextMaxChars - head.length - 2;
  const local = room > 200 ? buildContext(db, { ...settings, contextMaxChars: room }, raw.cwd as string | undefined) : '';
  return [head, local].filter(Boolean).join('\n\n');
}
