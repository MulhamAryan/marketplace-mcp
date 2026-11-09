# marketplace-mcp

Claude Code **marketplace** for Eonix internal tooling. Hosts the `eonix-mcp` plugin: the Eonix MCP
memory/knowledge connector (OAuth) plus the auto-injection hooks and **AI Eonix Memory**.

One install gives a developer the Eonix memory/knowledge system:

- **`marketplace` MCP server** registered as an **OAuth connector** (first use opens a browser →
  marketplace login; subsequent sessions renew silently).
- **Auto-injection hooks** (official knowledge + project notes + consolidation nudge on each prompt,
  episodic capture).
- **AI Eonix Memory**: a local worker whose background AI agents write the team notes and consolidate
  episodes, plus a SessionStart context (see below).

Where to see the result: notes on <https://marketplace.eonix.be/Memory> (graph of links:
<https://marketplace.eonix.be/Memory/Graph>), official norms on <https://marketplace.eonix.be/Knowledge>.

## Install (new dev)

Prerequisite: **Node.js >= 22.5** on `PATH` (`node -v`). Without it the server hooks still work, but
AI Eonix Memory does not run: no background note-taking, no consolidation.

```bash
claude plugin marketplace add MulhamAryan/marketplace-mcp
claude plugin install eonix-mcp@eonix
```

That's it — no env var, no PAT to copy, no `setx`. On first use (a hook firing, or a `marketplace`
tool call), the browser opens for the marketplace login; Claude Code stores the resulting token itself
and renews it silently from then on.

Update an existing install: `/plugin update` (or `claude plugin update eonix-mcp@eonix`), then
`/reload-plugins` or restart Claude Code. The worker restarts by itself on the next hook.

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
.claude-plugin/plugin.json        server hooks (mcp_tool): knowledge, notes, consolidation reminder, episodic capture
hooks/hooks.json                  command hooks of AI Eonix Memory, the local worker (all events)
.mcp.json                         the `marketplace` MCP server (HTTP + OAuth, alwaysLoad: true)
worker/                           eonix-mem worker sources (TypeScript); dist/eonix-mem.mjs is the committed bundle
```

Single-plugin marketplace, so the plugin's own files live at the repo root instead of under a
`plugins/<name>/` subdirectory (`marketplace.json`'s `source` is `"."`).

The backend (Marketplace.Web + Marketplace.Mcp + Postgres) lives in the separate
`skill-marketplace` repository. **The worker needs no server change**: it only uses existing MCP tools.

## What the plugin does

| When | What | Who |
|---|---|---|
| Every prompt | relevant team notes + official norms injected | `hook_notes_check`, `hook_knowledge_check` (unchanged) |
| Every prompt, edit, command, end of turn | episode sent to the server | `hook_capture` (unchanged) |
| Every prompt, tool call, end of turn | full turn kept locally (tool results included) | worker |
| End of each turn (Stop + 3 s) | team distill rules applied: `list_cibles` then `remember`, or nothing | worker, **distill agent** |
| Every 30 min | pending episodes consolidated: `pending_consolidations` → `remember` → `mark_consolidated` | worker, **consolidation agent** |
| Session start | background notice + local memory of the project | worker |

Team notes, episodes and their types are exactly the same as before; only the actor of the distill
and consolidation changes (a background agent instead of the developer's session, which no longer
gets interrupted at each turn end — `hook_distill_reminder` was removed in v0.8.0).

## AI Eonix Memory (local worker)

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

### Background agents

Both agents run **Claude Haiku 5.5** through the Claude Agent SDK, driving the developer's **installed
`claude`** (same login, no API key; the SDK's own ~330 MB native binary is not shipped).

- They reach the server through **this plugin's OAuth connector**: the agent session loads the plugin,
  so it reuses the login Claude Code already holds. No token to provision or distribute.
- Isolation: no local settings (`settingSources: []`), **all hooks disabled** (`disableAllHooks`), no
  built-in tools, permission mode `dontAsk` with only the listed MCP tools allowed
  (distill: `list_cibles`, `remember`; consolidation: `pending_consolidations`, `list_cibles`,
  `remember`, `mark_consolidated`). An agent session never records itself.
- The distill agent follows the team's existing auto-distillation rules verbatim (default: remember
  nothing; Bug / Decision / BusinessRule / Pitfall / Documentation; reuse targets; ≤ 3 sentences).
  It also writes a local turn summary and local `Change` / `Discovery` notes, which never leave the machine.
- If `claude` is not on `PATH`, set `claudePath` in `~/.eonix-mem/settings.json`; without it, local
  capture still works and turns wait.

### SessionStart context and recall

At session start the worker injects the background notice (so the session does not distill or
consolidate itself), then, for the current project and within a token budget (`contextMaxTokens`;
hard cap 9500 characters, under Claude Code's 10,000 limit):

1. the last session summaries (request → what was done, what remains);
2. the most recent notes in full (team notes the agent wrote, local Change/Discovery);
3. an index of older ones, each with its token cost.

Claude opens more on demand through Bash:

- `node worker/dist/eonix-mem.mjs search "<words>" [--all]` — full-text search (FTS5), index lines.
- `node worker/dist/eonix-mem.mjs show <id> [<id>...]` — full notes.

### Check and troubleshoot (Windows / PowerShell)

The installed plugin lives in `%USERPROFILE%\.claude\plugins\cache\eonix\eonix-mcp\<version>`; the
worker's data, logs and settings in `%USERPROFILE%\.eonix-mem`.

```powershell
# Shortcut to the installed CLI (adapt the version)
$mem = "$env:USERPROFILE\.claude\plugins\cache\eonix\eonix-mcp\0.8.0\worker\dist\eonix-mem.mjs"

node $mem status                                   # "AI Eonix Memory: running"
Invoke-RestMethod http://127.0.0.1:37800/health | ConvertTo-Json   # agents + counters

# Worker log: one "distilled — team notes: ..." line ~15 s after each turn
Get-Content "$env:USERPROFILE\.eonix-mem\logs\worker.log" -Tail 20 -Encoding UTF8
Get-Content "$env:USERPROFILE\.eonix-mem\logs\worker.log" -Tail 5 -Wait -Encoding UTF8   # live

node $mem search "port"                            # local search (current project; --all for every project)
node $mem show 12                                  # one note in full
```

What the log lines mean:

| Line | Meaning |
|---|---|
| `agents on (claude-haiku-5-5 via …, plugin …)` | worker started, background agents active |
| `turn <session>#<n> distilled — team notes: none` | turn read, nothing durable (the normal case) |
| `turn … distilled — team notes: Pitfall pitfall:…` | a team note was written or updated → visible on /Memory |
| `consolidation <project>: N note(s), N cluster(s) marked` | episodes consolidated (every 30 min) |
| `agents off: claude=not found …` | `claude` not on `PATH` → set `claudePath` in settings.json |
| `turn … distill failed — giving up` | 3 failed attempts; the turn is dropped (local capture kept) |

Common problems:

- **Nothing in the log / `status` says not running**: check `node -v` (>= 22.5). Without Node, Claude
  Code itself reports the failing hook commands (`node` not found). With Node, look at
  `%USERPROFILE%\.eonix-mem\logs\hook.log`: hook errors are written there, never shown to Claude.
- **Port 37800 already used by something else**: set `"port": 37801` (any free port) in settings.json.
- **Start over locally**: stop the worker (`Invoke-RestMethod -Method Post http://127.0.0.1:37800/api/shutdown`),
  then delete `%USERPROFILE%\.eonix-mem`. Team notes on the server are not affected.

Settings (`%USERPROFILE%\.eonix-mem\settings.json`, every key optional; full list and defaults in
`worker/src/settings.ts`):

| Key | Default | Purpose |
|---|---|---|
| `agentModel` | `claude-haiku-5-5` | model of the background agents |
| `claudePath` | (auto, `where claude`) | path to `claude.exe` if not on `PATH` |
| `turnSettleMs` | `3000` | wait after a turn ends before distilling it |
| `orphanTurnAfterMs` | `600000` | a turn without end (session closed) is distilled after this |
| `consolidationIntervalMs` | `1800000` | consolidation period (30 min) |
| `consolidationClustersPerRun` | `3` | episode clusters consolidated per project per run |
| `contextMaxTokens` | `1800` | budget of the local memory injected at session start |
| `port` | `37800` | loopback port of the worker |

Example: `{ "consolidationIntervalMs": 600000 }` to consolidate every 10 min.

## Auth model

- **MCP tools AND hooks** → the same OAuth 2.1 `authorization_code` + PKCE + refresh session (marketplace
  login; ADFS federation was removed). No token to copy, nothing to set with `setx`.
- Server hooks are wired as `mcp_tool` hooks (`hook_knowledge_check`, `hook_notes_check`,
  `hook_consolidation_check`, `hook_capture` on the `marketplace` server) instead of raw HTTP calls with
  a static bearer token — they ride on whichever MCP session is already connected, so there's no separate
  credential to provision, rotate, or corrupt (the old static PAT model hit a real bug: `setx` silently
  truncates values over 1024 characters, and the PAT is a ~1400-char JWT).
- The legacy `/api/hook/*` HTTP endpoints (static `EONIX_HOOK_TOKEN` PAT) are not used: tokens issued before the
  server's signing-key rotation are rejected (ID2090). The worker's agents use the OAuth connector instead.

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
