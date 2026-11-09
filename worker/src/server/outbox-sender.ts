import type { Db } from '../storage/db.js';
import type { Settings } from '../settings.js';
import { ackOutbox, dropExhaustedOutbox, failOutbox, nextOutbox } from '../storage/outbox.js';
import { postHook, serverConfigured, ServerError, type HookEndpoint } from './remote.js';
import { log } from '../log.js';

/**
 * Relays queued episodes to the server, oldest first, so a hook never waits on the network and
 * nothing is lost while the server or the network is down. Stops at the first failure to keep order.
 */
export class OutboxSender {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly db: Db,
    private readonly settings: Settings,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.flush(), this.settings.outboxIntervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async flush(): Promise<number> {
    if (this.running || !serverConfigured(this.settings)) return 0;
    this.running = true;
    let sent = 0;
    try {
      for (const row of nextOutbox(this.db, 50)) {
        try {
          await postHook(this.settings, row.endpoint as HookEndpoint, JSON.parse(row.payload));
          ackOutbox(this.db, row.id);
          sent++;
        } catch (err) {
          const status = err instanceof ServerError ? err.status : null;
          failOutbox(this.db, row.id, err instanceof Error ? err.message : String(err));
          // A 4xx other than auth means this payload will never be accepted: do not block the queue on it.
          if (status !== null && status >= 400 && status < 500 && status !== 401 && status !== 403) continue;
          log('worker', `outbox paused: ${err instanceof Error ? err.message : String(err)}`);
          break;
        }
      }
      const dropped = dropExhaustedOutbox(this.db, this.settings.outboxMaxAttempts);
      if (dropped > 0) log('worker', `outbox: dropped ${dropped} episode(s) after ${this.settings.outboxMaxAttempts} attempts`);
    } finally {
      this.running = false;
    }
    return sent;
  }
}
