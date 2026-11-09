import { runHook } from '../src/cli/hook-command.js';
import { loadSettings } from '../src/settings.js';
import { workerHealthy } from '../src/cli/client.js';

/**
 * eonix-mem CLI
 *   start          run the worker in the foreground (spawned detached by hooks)
 *   hook <event>   Claude Code hook entry point (SessionStart | UserPromptSubmit | PostToolUse | PostToolUseFailure | Stop)
 *   status         print whether the worker answers /health
 *
 * Never call process.exit() after a fetch: on Windows it aborts with a libuv assertion
 * (UV_HANDLE_CLOSING) while undici sockets are closing. Set exitCode and let the loop drain.
 */
async function main(argv: string[]): Promise<void> {
  const [command, arg] = argv;
  switch (command) {
    case 'start': {
      // Lazy: keeps node:sqlite (and its startup cost) out of the hook path.
      const { runWorker } = await import('../src/server/start.js');
      await runWorker();
      return;
    }
    case 'hook':
      await runHook(arg ?? '');
      process.exitCode = 0;
      return;
    case 'status': {
      const ok = await workerHealthy(loadSettings());
      process.stdout.write(ok ? 'eonix-mem worker: running\n' : 'eonix-mem worker: not running\n');
      process.exitCode = ok ? 0 : 1;
      return;
    }
    default:
      process.stdout.write('usage: eonix-mem start | hook <event> | status\n');
      process.exitCode = command ? 2 : 0;
  }
}

main(process.argv.slice(2)).catch(() => {
  // A hook must never fail Claude Code.
  process.exitCode = 0;
});
