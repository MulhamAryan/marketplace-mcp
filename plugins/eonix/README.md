# Eonix MCP plugin for Claude Code

One install gives a developer the Eonix memory/knowledge system:

- **`marketplace` MCP server** registered as an **OAuth/ADFS connector** (first use opens a browser → ADFS login on VPN; subsequent sessions renew silently).
- **Auto-injection hooks** (official knowledge + project notes on each prompt, episodic capture).

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

## What's inside

| File | Role |
|------|------|
| `.claude-plugin/plugin.json` | Hooks (SessionStart / UserPromptSubmit / PostToolUse / Stop) |
| `.mcp.json` | The `marketplace` MCP server (HTTP, OAuth — no static secret) |

The marketplace manifest (`.claude-plugin/marketplace.json`) lives at the repo root.

## Auth model

- **MCP tools AND hooks** → the same OAuth 2.1 `authorization_code` + PKCE + refresh session (federated
  to ADFS). No token to copy, nothing to set with `setx`.
- Hooks are wired as `mcp_tool` hooks (`hook_knowledge_check`, `hook_notes_check`, `hook_session_start`,
  `hook_capture` on the `marketplace` server) instead of raw HTTP calls with a static bearer token — they
  ride on whichever MCP session is already connected, so there's no separate credential to provision,
  rotate, or corrupt (the old static PAT model hit a real bug: `setx` silently truncates values over
  1024 characters, and the PAT is a ~1400-char JWT).
- The legacy `/api/hook/*` HTTP endpoints (static `EONIX_HOOK_TOKEN` PAT) still exist server-side during
  the transition, but this plugin no longer calls them.

The CLAUDE.md operating rules are delivered server-side via the `SessionStart` hook — no local CLAUDE.md
to copy, and the rules stay centrally updatable.
