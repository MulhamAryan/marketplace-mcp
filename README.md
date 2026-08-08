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

Override the MCP base URL only if you're pointing at a non-prod instance (local/VPN):

```bash
setx EONIX_MCP_URL "https://mcp.marketplace.eonix.be"
```

## Layout

```
.claude-plugin/marketplace.json   marketplace manifest (name: eonix)
.claude-plugin/plugin.json        hooks (UserPromptSubmit / PostToolUse / Stop)
.mcp.json                         the `marketplace` MCP server (HTTP + OAuth)
```

Single-plugin marketplace, so the plugin's own files live at the repo root instead of under a
`plugins/<name>/` subdirectory (`marketplace.json`'s `source` is `"."`).

The backend (Marketplace.Web + Marketplace.Mcp + Postgres) lives in the separate
`skill-marketplace` repository.

## Auth model

- **MCP tools AND hooks** → the same OAuth 2.1 `authorization_code` + PKCE + refresh session (federated
  to ADFS). No token to copy, nothing to set with `setx`.
- Hooks are wired as `mcp_tool` hooks (`hook_knowledge_check`, `hook_notes_check`,
  `hook_consolidation_check`, `hook_capture` on the `marketplace` server) instead of raw HTTP calls with
  a static bearer token — they ride on whichever MCP session is already connected, so there's no separate
  credential to provision, rotate, or corrupt (the old static PAT model hit a real bug: `setx` silently
  truncates values over 1024 characters, and the PAT is a ~1400-char JWT).
- The legacy `/api/hook/*` HTTP endpoints (static `EONIX_HOOK_TOKEN` PAT) still exist server-side during
  the transition, but this plugin no longer calls them.

## Known limitation: no SessionStart hook

Claude Code cannot run `mcp_tool` hooks on `SessionStart` (no MCP client context exists that early —
every attempt fails with "mcp_tool hooks are not available for the 'SessionStart' hook event"). So:

- `hook_session_start` exists server-side but is **not wired to anything** — it would only ever error.
- The consolidation nudge it computes is instead served by `hook_consolidation_check`, wired on
  `UserPromptSubmit` (an event that does run `mcp_tool` hooks), once the MCP session connects.
- The full "MANDATORY STARTUP REMINDER" ruleset (auto-distillation, episodic memory, knowledge base
  instructions) is **not** delivered automatically at all right now — there is no working server-side
  delivery path for it. Until a real fix exists (e.g. serving it via `hook_knowledge_check`/
  `hook_notes_check` on the first `UserPromptSubmit`, or a Claude Code `SessionStart` mode that supports
  `mcp_tool`), keep a local copy of the ruleset in your own `~/.claude/CLAUDE.md`.
