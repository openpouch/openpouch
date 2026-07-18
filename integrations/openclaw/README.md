# openpouch × OpenClaw

## Deploy skill

[`openpouch-deploy/SKILL.md`](openpouch-deploy/SKILL.md) — a thin skill that teaches OpenClaw when to reach for openpouch and the canonical workflows (shape-based deploy command, verify-before-report, self-repair loop, resume from `DEPLOYMENT.md`). It wraps the plain CLI (`npx openpouch deploy --json`); no OpenClaw-exclusive behavior exists or is intended — the skill body is deliberately identical to the Claude Code variant, because the capabilities are identical everywhere.

Install into an OpenClaw workspace: copy the `openpouch-deploy/` folder into your skills directory. Once published on ClawHub, installing by name is the shorter path (see the ClawHub listing for the current install command).

## MCP alternative

OpenClaw's MCP support can load the openpouch server directly:

```json
{
  "mcpServers": {
    "openpouch": { "command": "npx", "args": ["-y", "@openpouch/mcp"] }
  }
}
```

## Plain CLI also works

No skill, no MCP: OpenClaw's shell tool can run `npx openpouch deploy --json` as-is — same JSON contract, exit codes, and repo truth files. See [docs/HARNESSES.md](../../docs/HARNESSES.md).

---

*Maintainer note (publish checklist): the ClawHub listing should use the skill name `openpouch-deploy`, the description line from the SKILL.md frontmatter, and link back to this repository. Production `approve` remains human-only — the skill must never claim otherwise.*
