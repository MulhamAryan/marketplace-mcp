import { runHook } from '../src/cli/hook-command.js';
import { loadSettings, PRODUCT_NAME } from '../src/settings.js';
import { workerGet, workerHealthy } from '../src/cli/client.js';
import { ensureWorker } from '../src/server/bootstrap.js';
import { projectFromCwd } from '../src/project.js';

/**
 * AI Eonix Memory CLI (eonix-mem)
 *   start                        run the worker in the foreground (spawned detached by hooks)
 *   hook <event>                 Claude Code hook entry point
 *   status                       print whether the worker answers /health
 *   search "<words>" [--all]     search local observations (current project unless --all)
 *   show <id> [<id>...]          print full observations
 *
 * Never call process.exit() after a fetch: on Windows it aborts with a libuv assertion
 * (UV_HANDLE_CLOSING) while undici sockets are closing. Set exitCode and let the loop drain.
 */
async function main(argv: string[]): Promise<void> {
  const [command, ...args] = argv;
  switch (command) {
    case 'start': {
      // Lazy: keeps node:sqlite and the Agent SDK out of the hook path.
      const { runWorker } = await import('../src/server/start.js');
      await runWorker();
      return;
    }
    case 'hook':
      await runHook(args[0] ?? '');
      process.exitCode = 0;
      return;
    case 'status': {
      const ok = await workerHealthy(loadSettings());
      process.stdout.write(ok ? `${PRODUCT_NAME}: running\n` : `${PRODUCT_NAME}: not running\n`);
      process.exitCode = ok ? 0 : 1;
      return;
    }
    case 'search':
    case 'show': {
      const settings = loadSettings();
      if (!(await ensureWorker(settings))) {
        process.stdout.write(`${PRODUCT_NAME}: worker unavailable\n`);
        process.exitCode = 1;
        return;
      }
      const all = args.includes('--all');
      const rest = args.filter((a) => a !== '--all');
      const path =
        command === 'search'
          ? `/api/search?${new URLSearchParams({ q: rest.join(' '), project: all ? '' : projectFromCwd(process.cwd()) })}`
          : `/api/observations?${new URLSearchParams({ ids: rest.join(',') })}`;
      const { text } = await workerGet<{ text: string }>(settings, path);
      process.stdout.write(`${text}\n`);
      return;
    }
    default:
      process.stdout.write(`${PRODUCT_NAME}\nusage: eonix-mem start | hook <event> | status | search "<words>" [--all] | show <id>...\n`);
      process.exitCode = command ? 2 : 0;
  }
}

main(process.argv.slice(2)).catch(() => {
  // A hook must never fail Claude Code.
  process.exitCode = 0;
});
