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

/** Result of one agent run on one project. */
export interface ConsolidationRun {
  notes: number;
  marked: number;
}

/**
 * Background consolidation: runs the team's existing loop — pending_consolidations, remember,
 * mark_consolidated — through an agent, so the developer's session never has to.
 *
 * Event-driven, near real time:
 * - after each distilled turn, the turn's project is queued and consolidated consolidationDebounceMs
 *   later (turns that follow quickly share one run);
 * - while a run fills its batch (marked >= consolidationClustersPerRun), the project is queued again
 *   right away: a backlog drains continuously, one agent at a time;
 * - a run that marks fewer clusters than its batch means nothing consolidable is left (remaining
 *   clusters are noise the agent leaves untouched), so draining stops — no endless loop;
 * - a slow fallback sweep (consolidationIntervalMs) covers every active project anyway.
 */
export class ConsolidationJob {
  private sweepTimer: NodeJS.Timeout | undefined;
  private debounceTimer: NodeJS.Timeout | undefined;
  private readonly queue = new Set<string>();
  private running = false;
  private stopped = false;

  constructor(
    private readonly db: Db,
    private readonly settings: Settings,
    private readonly provider: AgentProvider,
  ) {}

  start(): void {
    this.sweepTimer = setInterval(() => {
      for (const p of activeProjects(this.db, this.settings.consolidationActiveProjectDays)) this.queue.add(p);
      void this.drain();
    }, this.settings.consolidationIntervalMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
  }

  /** Asks for a consolidation of `project` soon (debounced). Called after each distilled turn. */
  request(project: string): void {
    if (this.stopped) return;
    this.queue.add(project);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => void this.drain(), this.settings.consolidationDebounceMs);
  }

  /** Consolidates queued projects one run at a time until the queue is empty. Returns notes written. */
  async drain(): Promise<number> {
    if (this.running) return 0; // the running drain picks up whatever was queued meanwhile
    this.running = true;
    let notes = 0;
    try {
      while (this.queue.size > 0 && !this.stopped) {
        const [project] = this.queue;
        this.queue.delete(project);
        const run = await this.runProject(project);
        notes += run.notes;
        if (run.marked >= this.settings.consolidationClustersPerRun) this.queue.add(project); // backlog: keep going
      }
    } finally {
      this.running = false;
    }
    return notes;
  }

  /** One agent run on one project; never throws. */
  async runProject(project: string): Promise<ConsolidationRun> {
    try {
      const result = await this.provider.run({
        systemPrompt: consolidationSystemPrompt(project, this.settings.consolidationClustersPerRun),
        prompt: `Consolidate the pending episodes of project "${project}".`,
        mcpTools: ['pending_consolidations', 'list_cibles', 'remember', 'mark_consolidated'],
        maxTurns: 6 + 4 * this.settings.consolidationClustersPerRun,
        timeoutMs: this.settings.consolidationTimeoutMs,
      });
      const notes = result.toolCalls.filter((c) => c.tool === 'remember' && c.ok).length;
      const marked = result.toolCalls.filter((c) => c.tool === 'mark_consolidated' && c.ok).length;
      log('worker', `consolidation ${project}: ${notes} note(s), ${marked} cluster(s) marked`);
      return { notes, marked };
    } catch (err) {
      log('worker', `consolidation ${project} failed`, err);
      return { notes: 0, marked: 0 };
    }
  }
}
