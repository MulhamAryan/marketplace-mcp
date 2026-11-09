import type { Db } from '../storage/db.js';
import type { Settings } from '../settings.js';
import { projectFromCwd } from '../project.js';
import { recentObservations, recentSummaries } from '../storage/observations.js';
import { ContextBudget } from './budget.js';
import { renderIndexLine, renderObservation, renderSummary } from './render.js';

/**
 * SessionStart context for a project, within the token budget. Priority order:
 * recent session summaries, then the most recent observations in full, then a compact index of
 * older ones (with their token cost) that Claude can open on demand through the CLI.
 * Returns '' when the project has no compressed memory yet: nothing is injected.
 */
export function buildContext(db: Db, settings: Settings, cwd: string | undefined, cliPath = process.argv[1]): string {
  const project = projectFromCwd(cwd);
  const observations = recentObservations(db, project, settings.contextIndexObservations);
  const summaries = recentSummaries(db, project, settings.contextSummaries);
  if (observations.length === 0 && summaries.length === 0) return '';

  const budget = new ContextBudget(settings.contextMaxTokens, settings.contextMaxChars);
  const cli = `node "${cliPath}"`;
  budget.tryAdd(
    `# Mémoire locale (eonix-mem) — ${project}\n` +
      `Extraits des sessions précédentes sur ce poste. Pour le détail : \`${cli} show <id>\` ; ` +
      `pour chercher : \`${cli} search "<mots>"\`.`,
  );

  if (summaries.length > 0) {
    budget.tryAdd('\n## Dernières sessions');
    for (const s of summaries) if (!budget.tryAdd(renderSummary(s))) break;
  }

  const full = observations.slice(0, settings.contextFullObservations);
  const indexed = observations.slice(settings.contextFullObservations);
  if (full.length > 0) {
    budget.tryAdd('\n## Observations récentes');
    for (const o of full) if (!budget.tryAdd(renderObservation(o))) indexed.unshift(o);
  }

  let shown = 0;
  if (indexed.length > 0 && budget.tryAdd('\n## Index (plus anciennes)')) {
    for (const o of indexed) {
      if (!budget.tryAdd(renderIndexLine(o))) break;
      shown++;
    }
  }
  const hidden = indexed.length - shown;
  if (hidden > 0) budget.tryAdd(`… ${hidden} observation(s) plus ancienne(s) non affichée(s) — utiliser search.`, true);

  return budget.render();
}
