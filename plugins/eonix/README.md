# Eonix MCP plugin for Claude Code

One install gives a developer the Eonix memory/knowledge system:

- **`marketplace` MCP server** registered as an **OAuth/ADFS connector** (first use opens a browser → ADFS login on VPN; subsequent sessions renew silently).
- **Auto-injection hooks** (official knowledge + project notes on each prompt, episodic capture).

## Install (new dev)

```bash
claude plugin marketplace add MulhamAryan/marketplace-mcp
claude plugin install eonix-mcp@eonix
```

Then set the two per-dev values the hooks need (minted for you by the **/Mcp** setup page):

```bash
# The base URL of the Eonix MCP (default is the public prod URL, override for local/VPN):
setx EONIX_MCP_URL   "https://mcp.marketplace.eonix.be"
# Your personal hook token (long-lived PAT, scoped to notes/knowledge) from /Mcp:
setx EONIX_HOOK_TOKEN "<pat-from-/Mcp>"
```

Restart Claude Code. On first use of a `marketplace` tool, the browser opens for the ADFS login.

## What's inside

| File | Role |
|------|------|
| `.claude-plugin/plugin.json` | Hooks (SessionStart / UserPromptSubmit / PostToolUse / Stop) |
| `.mcp.json` | The `marketplace` MCP server (HTTP, OAuth — no static secret) |

The marketplace manifest (`.claude-plugin/marketplace.json`) lives at the repo root.

## Auth model

- **MCP tools** → OAuth 2.1 `authorization_code` + PKCE + refresh (federated to ADFS). No token to copy.
- **Hooks** (headless) → a long-lived **PAT** in `Authorization: Bearer` (GitHub-PAT model), minted once by
  `/Mcp` and scoped to `notes`/`knowledge` only. Revoke by re-provisioning (rotation).

The CLAUDE.md operating rules are delivered server-side via the `SessionStart` hook — no local CLAUDE.md
to copy, and the rules stay centrally updatable.
