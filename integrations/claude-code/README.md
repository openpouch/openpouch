# openpouch × Claude Code

Two independent ways to integrate — most setups want both:

## 1. MCP server (native tools)

```bash
claude mcp add openpouch -- npx -y @openpouch/mcp
```

Claude Code now has every openpouch capability as typed tools (`openpouch_deploy`, `openpouch_verify`, `openpouch_logs`, `openpouch_inspect`, `openpouch_list`, `openpouch_delete`, `openpouch_whoami`, …) — everything except production `approve`, which is human-only by design in every interface. Tool reference: [docs/MCP.md](../../docs/MCP.md).

## 2. Deploy skill (workflow knowledge)

The skill teaches Claude Code *when* to deploy with openpouch and the canonical workflows (shape-based deploy command, verify-before-report, self-repair loop, resume from `DEPLOYMENT.md`). It wraps the plain CLI, so it works with or without the MCP server.

Install for one project:

```bash
mkdir -p .claude/skills/openpouch-deploy
curl -fsSL https://raw.githubusercontent.com/openpouch/openpouch/main/integrations/claude-code/skills/openpouch-deploy/SKILL.md \
  -o .claude/skills/openpouch-deploy/SKILL.md
```

Install for all your projects: same file into `~/.claude/skills/openpouch-deploy/SKILL.md`.

Then just ask Claude Code to *"deploy this and give me a link for my client"* — it runs `npx openpouch deploy`, verifies health, and relays the live URL plus a plain-language summary.

## No integration at all also works

Claude Code can simply run the CLI (`npx openpouch deploy --json`) — the JSON contract, exit codes, and repo truth files are the same. See [docs/HARNESSES.md](../../docs/HARNESSES.md).
