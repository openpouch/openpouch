# @openpouch/mcp 🦘

The **openpouch MCP server** — the same governed deploy capabilities as the `openpouch` CLI, exposed as standard [Model Context Protocol](https://modelcontextprotocol.io) tools over stdio. Works with **any** MCP-capable harness (Claude Code, Codex, Cursor, Windsurf, …) — harness neutrality is a design rule.

> Most agents don't need this — the `openpouch` CLI (`npx openpouch deploy`) works in any shell. Use the MCP server when you want the typed tool surface in an MCP client.

## What it gives an agent

Twelve tools wrapping the same command functions as the CLI (identical behavior, no drift): `openpouch_init`, `openpouch_inspect`, `openpouch_plan`, `openpouch_deploy_preview`, `openpouch_deploy_production`, `openpouch_verify`, `openpouch_logs`, `openpouch_rollback`, `openpouch_list_approvals`, `openpouch_whoami`, `openpouch_list` (list your account's instant-lane apps), `openpouch_delete` (delete one of your own apps to free a quota slot).

**There is deliberately no `approve` tool.** Approving a production deploy is human-only (interactive terminal) — an agent can never approve its own deploys, in any harness. If a tool returns `approval-required` with a request id, ask your human to run `openpouch approve <id>` in their own terminal.

## Run it

No install needed:

```
npx -y @openpouch/mcp
```

It speaks stdio MCP — point your client's MCP config at that command.

### Claude Code

```
claude mcp add openpouch -- npx -y @openpouch/mcp
```

### Codex / Cursor / Windsurf (and most clients) — config block

```json
{
  "mcpServers": {
    "openpouch": {
      "command": "npx",
      "args": ["-y", "@openpouch/mcp"]
    }
  }
}
```

(Codex uses `~/.codex/config.toml`; the equivalent is `command = "npx"`, `args = ["-y", "@openpouch/mcp"]` under an `[mcp_servers.openpouch]` table.)

## Links

- Product + docs: https://openpouch.dev
- MCP tools, tool by tool: https://openpouch.dev/docs/MCP.md
- Harness integration matrix: https://openpouch.dev/docs/HARNESSES.md
- CLI (the universal path): https://www.npmjs.com/package/openpouch
- Source (Apache-2.0): https://github.com/openpouch/openpouch

Apache-2.0.
