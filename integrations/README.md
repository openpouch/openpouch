# Harness integrations

Ready-to-install conveniences for specific agent harnesses. **None of these add capability** — they wrap the same neutral surfaces every harness gets (CLI with `--json`, MCP server, repo truth files; see [docs/HARNESSES.md](../docs/HARNESSES.md)). That's a design rule: no harness-exclusive features, and production `approve` stays human-only in every interface.

| Directory | Harness | What it is |
|---|---|---|
| [`claude-code/`](claude-code/) | Claude Code | MCP one-liner + an installable deploy **skill** (`SKILL.md`) |
| [`openclaw/`](openclaw/) | OpenClaw | Deploy skill for ClawHub (same `SKILL.md` standard) |

**Other harnesses** (Codex, Hermes, Cursor, Windsurf, …) need no files from here: use the MCP config block or plain CLI from [docs/HARNESSES.md](../docs/HARNESSES.md). Copy-paste rule blocks for Cursor and Codex live there too.

The skills are intentionally thin: they teach the harness *when* to reach for openpouch and the canonical workflows (deploy → verify → relay summary; self-repair loop; resume from `DEPLOYMENT.md`). The single source of truth remains the CLI/MCP output itself and [llms.txt](../llms.txt).
