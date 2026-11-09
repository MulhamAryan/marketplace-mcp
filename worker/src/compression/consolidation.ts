import type { Db } from '../storage/db.js';
import type { Settings } from '../settings.js';
import { consolidationSystemPrompt } from './prompts.js';
import type { AgentProvider } from './provider.js';
import { log } from '../log.js';

/** Projects with local activity in the last `days`: the ones worth consolidating on the server. */
export function activeProjects(db: Db, days: number): string[] {
  const since = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
  return (
    db.prepare('SELECT DISTINCT project FROM sessions WHERE started_at >= ? ORDER BY project').all(since) as { project: string }[]
  ).map((r) => r.project);
}

/**
 * Background consolidation: periodically runs the team's existing loop — pending_consolidations,
 * remember, mark_consolidated — through an agent, per active project, instead of nudging the
 * developer's session to do it. The server-side episodes and notes are the same as before.
 */
export class ConsolidationJob {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly db: Db,
    private readonly settings: Settings,
    private readonly provider: AgentProvider,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.runOnce(), this.settings.consolidationIntervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async runOnce(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let notes = 0;
    try {
      for (const project of activeProjects(this.db, this.settings.consolidationActiveProjectDays)) {
        try {
          const result = await this.provider.run({
            systemPrompt: consolidationSystemPrompt(project, this.settings.consolidationClustersPerRun),
            prompt: `Consolidate the pending episodes of project "${project}".`,
            mcpTools: ['pending_consolidations', 'list_cibles', 'remember', 'mark_consolidated'],
            maxTurns: 6 + 4 * this.settings.consolidationClustersPerRun,
            timeoutMs: this.settings.consolidationTimeoutMs,
          });
          const written = result.toolCalls.filter((c) => c.tool === 'remember' && c.ok).length;
          const marked = result.toolCalls.filter((c) => c.tool === 'mark_consolidated' && c.ok).length;
          notes += written;
          log('worker', `consolidation ${project}: ${written} note(s), ${marked} cluster(s) marked`);
        } catch (err) {
          log('worker', `consolidation ${project} failed`, err);
        }
      }
    } finally {
      this.running = false;
    }
    return notes;
  }
}
