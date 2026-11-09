import type { Db } from './db.js';

export function counts(db: Db): Record<string, number> {
  const one = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  return {
    sessions: one('SELECT COUNT(*) AS n FROM sessions'),
    prompts: one('SELECT COUNT(*) AS n FROM prompts'),
    rawEvents: one('SELECT COUNT(*) AS n FROM raw_events'),
    rawEventsPending: one(`SELECT COUNT(*) AS n FROM raw_events WHERE status = 'pending'`),
    rawEventsFailed: one(`SELECT COUNT(*) AS n FROM raw_events WHERE status = 'failed'`),
    observations: one('SELECT COUNT(*) AS n FROM observations'),
    teamNotesWritten: one(`SELECT COUNT(*) AS n FROM observations WHERE share_status = 'pushed'`),
    summaries: one('SELECT COUNT(*) AS n FROM summaries'),
    summariesPending: one(`SELECT COUNT(*) AS n FROM summaries WHERE status = 'pending'`),
  };
}
