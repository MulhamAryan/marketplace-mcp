import type { Db } from '../storage/db.js';
import { PRODUCT_NAME, type Settings } from '../settings.js';
import { buildContext } from '../context/builder.js';

/**
 * Tells the session that note-taking now happens in the background, so it is not done twice. It also
 * answers the consolidation nudge that hook_consolidation_check still appends server-side.
 */
export const BACKGROUND_NOTICE =
  `La mémoire d'équipe est alimentée automatiquement en arrière-plan par ${PRODUCT_NAME} : à la fin de chaque ` +
  'tour, un agent applique les règles de distillation (list_cibles puis remember), et un autre consolide ' +
  'les épisodes en attente (pending_consolidations). Ne le fais pas toi-même, même si un rappel te le ' +
  'propose, sauf si le développeur le demande explicitement.';

/** SessionStart context: the background notice (when agents run), then the local memory of the project. */
export function sessionContext(db: Db, settings: Settings, cwd: string | undefined, agentsOn: boolean): string {
  const head = agentsOn ? BACKGROUND_NOTICE : '';
  const room = settings.contextMaxChars - head.length - 2;
  const local = buildContext(db, { ...settings, contextMaxChars: room }, cwd);
  return [head, local].filter(Boolean).join('\n\n');
}
