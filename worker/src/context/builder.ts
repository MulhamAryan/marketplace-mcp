import type { Db } from '../storage/db.js';
import type { Settings } from '../settings.js';
import { projectFromCwd } from '../project.js';

/**
 * SessionStart context. Placeholder until step 4 (token budget, observation index):
 * returns an empty string when the project has no compressed memory yet, so nothing is injected.
 */
export function buildContext(db: Db, _settings: Settings, cwd: string | undefined): string {
  const project = projectFromCwd(cwd);
  const rows = db
    .prepare('SELECT id, type, title, created_at FROM observations WHERE project = ? ORDER BY id DESC LIMIT 20')
    .all(project) as { id: number; type: string; title: string; created_at: string }[];
  if (rows.length === 0) return '';
  const lines = rows.map((r) => `- #${r.id} [${r.type}] ${r.title} (${r.created_at.slice(0, 10)})`);
  return `# Mémoire locale (eonix-mem) — ${project}\n${lines.join('\n')}`;
}
