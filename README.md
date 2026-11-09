# marketplace-mcp

Claude Code **marketplace** for Eonix internal tooling. Hosts the `eonix-mcp` plugin: the Eonix MCP
memory/knowledge connector (OAuth/ADFS) plus the auto-injection hooks.

One install gives a developer the Eonix memory/knowledge system:

- **`marketplace` MCP server** registered as an **OAuth/ADFS connector** (first use opens a browser →
  ADFS login on VPN; subsequent sessions renew silently).
- **Auto-injection hooks** (official knowledge + project notes + consolidation nudge on each prompt,
  episodic capture).

## Install (new dev)

```bash
claude plugin marketplace add MulhamAryan/marketplace-mcp
claude plugin install eonix-mcp@eonix
```

That's it — no env var, no PAT to copy, no `setx`. On first use (a hook firing, or a `marketplace`
tool call), the browser opens for the ADFS login; Claude Code stores the resulting token itself and
renews it silently from then on.

## Prod mode vs dev mode

The `marketplace` MCP server URL in `.mcp.json` is `${EONIX_MCP_URL:-https://mcp.marketplace.eonix.be}/mcp`:
no `EONIX_MCP_URL` set means **prod mode** (default, nothing to configure). Setting it points the
plugin at a different instance — typically the **dev mode** local Docker stack.

Local Docker stack URLs (dev mode):

| Service                  | URL                                                |
|---------------------------|-----------------------------------------------------|
| Web (marketplace, Studio) | `https://marketplace.local.eonix.be:59100`          |
| Studio                    | `https://marketplace.local.eonix.be:59100/Studio`   |
| MCP (tool server)         | `https://mcp.marketplace.local.eonix.be:59101/mcp`  |

Switch to dev mode — set `EONIX_MCP_URL` to the MCP base URL **without** the `/mcp` suffix (it's
appended automatically by `.mcp.json`), then restart Claude Code so it picks up the new env var:

```powershell
setx EONIX_MCP_URL "https://mcp.marketplace.local.eonix.be:59101"
```

Switch back to prod mode — remove the override and restart Claude Code:

```powershell
[Environment]::SetEnvironmentVariable("EONIX_MCP_URL", $null, "User")
```

## Layout

```
.claude-plugin/marketplace.json   marketplace manifest (name: eonix)
.claude-plugin/plugin.json        mcp_tool hooks (UserPromptSubmit: knowledge, notes, consolidation reminder)
hooks/hooks.json                  command hooks of the local eonix-mem worker (all events)
.mcp.json                         the `marketplace` MCP server (HTTP + OAuth, alwaysLoad: true)
worker/                           eonix-mem worker sources (TypeScript); dist/eonix-mem.mjs is the committed bundle
```

## Local worker (eonix-mem)

Inspired by [claude-mem](https://github.com/thedotmack/claude-mem) (Apache-2.0, see `NOTICE`):
same flow, our own code.

- Requires **Node >= 22.5** on `PATH` (uses the built-in `node:sqlite`, so no `npm install` at runtime).
- One CLI for every hook: `node worker/dist/eonix-mem.mjs hook <event>`. Hooks are thin: they POST
  the event to the worker on `127.0.0.1:37800` and exit 0, always.
- The worker starts on demand (first hook, detached) and stays up; one per machine (the port is the lock).
- If the worker cannot be reached, the event goes to `~/.eonix-mem/spool/` and is replayed later.
- Data: `~/.eonix-mem/eonix-mem.db` (SQLite + FTS5). Logs: `~/.eonix-mem/logs/`. Tuning:
  `~/.eonix-mem/settings.json` (keys and defaults in `worker/src/settings.ts`).
- No UI on the worker: only `GET /health` for diagnostics (`node worker/dist/eonix-mem.mjs status`).
- Rebuild after changing sources: `cd worker && npm install && npm run build && npm test`, then commit `dist/`.

### Compression

After each turn (Stop + 3 s for late async tool events), the worker sends the turn — request,
tool calls with their results, final answer — to **Claude Haiku 5.5** in one call, in the background.
It returns typed observations plus a turn summary:

- `Decision`, `BusinessRule`, `Bug`, `Pitfall`, `Documentation` → marked to share with the team (step 5).
- `Change`, `Discovery` → stay on the machine.
- Unknown or malformed types fall back to `Discovery`: a model slip can never publish anything.

It runs through the Claude Agent SDK driving the developer's **installed `claude`** (same login,
no API key): the SDK's own native binary is ~330 MB per platform and is not shipped. The child
session is isolated (`settingSources: []`, no tools, no MCP, not persisted) and our hooks ignore it
(`EONIX_MEM_INTERNAL=1`), so it never records itself. If `claude` is not on `PATH`, set `claudePath`
in `~/.eonix-mem/settings.json`; without it, capture still works and turns wait uncompressed.

### SessionStart context and recall

At session start the worker injects, for the current project and within a token budget
(`contextMaxTokens`, default 2200; hard cap 9500 characters, under Claude Code's 10,000 limit):

1. the last session summaries (request → what was done, what remains);
2. the most recent observations in full;
3. an index of older ones, each with its token cost.

Nothing is injected for a project with no memory yet. Claude opens more on demand through Bash:

- `node worker/dist/eonix-mem.mjs search "<words>" [--all]` — full-text search (FTS5), index lines.
- `node worker/dist/eonix-mem.mjs show <id> [<id>...]` — full observations.

Next step: push of shareable observations to the server (step 5). `hook_distill_reminder` stays
wired until step 5 replaces it.

Single-plugin marketplace, so the plugin's own files live at the repo root instead of under a
`plugins/<name>/` subdirectory (`marketplace.json`'s `source` is `"."`).

The backend (Marketplace.Web + Marketplace.Mcp + Postgres) lives in the separate
`skill-marketplace` repository.

## Auth model

- **MCP tools AND hooks** → the same OAuth 2.1 `authorization_code` + PKCE + refresh session (federated
  to ADFS). No token to copy, nothing to set with `setx`.
- Server hooks are wired as `mcp_tool` hooks (`hook_knowledge_check`, `hook_notes_check`,
  `hook_consolidation_check`, `hook_distill_reminder` on the `marketplace` server; `hook_capture` was
  replaced by the local worker in v0.7.0) instead of raw HTTP calls with
  a static bearer token — they ride on whichever MCP session is already connected, so there's no separate
  credential to provision, rotate, or corrupt (the old static PAT model hit a real bug: `setx` silently
  truncates values over 1024 characters, and the PAT is a ~1400-char JWT).
- The legacy `/api/hook/*` HTTP endpoints (static `EONIX_HOOK_TOKEN` PAT) still exist server-side during
  the transition, but this plugin no longer calls them.

## Known limitation: no SessionStart hook

Claude Code cannot run `mcp_tool` hooks on `SessionStart` (no MCP client context exists that early —
every attempt fails with "mcp_tool hooks are not available for the 'SessionStart' hook event"). So:

- `hook_session_start` exists server-side but is **not wired to anything** — it would only ever error.
- Its full payload — the configurable "Hooks.SessionStartContext" ruleset (auto-distillation, episodic
  memory, knowledge base instructions) plus the consolidation nudge — is instead served by
  `hook_consolidation_check`, wired on `UserPromptSubmit` (an event that does run `mcp_tool` hooks), once
  the MCP session connects. Fixed server-side in `skill-marketplace`: delivered on every prompt rather
  than only once at session start, since there is no reliable "first prompt of a session" signal
  available to the hook.
- A local copy of the ruleset in your own `~/.claude/CLAUDE.md` is no longer required for it to reach the
  model, but can still be kept as a redundant safety net.

## Forcing the auto-distillation decision every turn

`hook_consolidation_check`'s reminder is only a nudge in the model's context — nothing stops the model
from silently skipping the decision. `hook_distill_reminder`, wired on `Stop` (fires at the end of
*every* turn, not just session end), returns a `systemMessage` the model must respond to before the
turn actually ends. This isn't a hard block: Claude Code's current hook contract only offers real
exit-code-2 blocking to `command`-type hooks, and doesn't expose a `stop_hook_active`-style loop guard
for `mcp_tool` hooks on `Stop` — `systemMessage` is the closest lever available without reintroducing
the infinite-reloop risk a blocking `agent`/`prompt`-type `Stop` hook hit in this project before.

## Connection race on the first prompt(s) of a session

Even on `UserPromptSubmit`, the very first prompts of a brand-new session can hit
`MCP server 'plugin:eonix-mcp:marketplace' not connected` if the OAuth-authenticated MCP session
hasn't finished connecting yet. There's no hook-level delay/retry for this (hooks in the same event
run in parallel, so a `sleep` hook wouldn't help — verified against Claude Code's own docs).

Mitigated (not fully eliminated) as of v0.5.0 by setting `"alwaysLoad": true` on the `marketplace`
server in `.mcp.json` — this makes Claude Code's startup **wait** for that server to connect (up to
the standard 5-second connect timeout) before building the first prompt, instead of connecting in the
background while you're already typing. For an already-authenticated dev (silent OAuth refresh) this
should cover most cases. If 5s isn't enough on a slow link, raise it per-developer with
`CLAUDE_CODE_MCP_CONNECT_TIMEOUT_MS` (env var, see Claude Code's `env-vars` docs) — not something this
plugin can set on a dev's behalf.
