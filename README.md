# marketplace-mcp

Claude Code **marketplace** for Eonix internal tooling. Hosts the `eonix-mcp` plugin: the Eonix MCP
memory/knowledge connector (OAuth/ADFS) plus the auto-injection hooks.

## Install

```bash
claude plugin marketplace add MulhamAryan/marketplace-mcp
claude plugin install eonix-mcp@eonix
```

Then set the two per-dev values (minted by the **/Mcp** page of the marketplace web app):

```bash
setx EONIX_MCP_URL    "https://mcp.marketplace.eonix.be"
setx EONIX_HOOK_TOKEN "<pat-from-/Mcp>"
```

Restart Claude Code. First use of a `marketplace` tool opens the browser for the ADFS login (VPN).

## Layout

```
.claude-plugin/marketplace.json   marketplace manifest (name: eonix)
plugins/eonix/
  .claude-plugin/plugin.json      hooks (UserPromptSubmit / PostToolUse / Stop)
  .mcp.json                       the `marketplace` MCP server (HTTP + OAuth)
  README.md                       plugin doc
```

The backend (Marketplace.Web + Marketplace.Mcp + Postgres) lives in the separate
`skill-marketplace` repository.
