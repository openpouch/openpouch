# openpouch — Claude Code plugin

Agent-native hosting for Claude Code: deploy any app or static site to a live URL in one command — no account, no CAPTCHA, no browser step.

## What's inside

- **MCP server** (`.mcp.json`): the full openpouch toolset as typed tools — `openpouch_deploy`, `openpouch_verify`, `openpouch_logs`, `openpouch_inspect`, `openpouch_list`, `openpouch_delete`, `openpouch_whoami`, and more. There is deliberately **no approve tool**: taking a governed app to production stays a human action in every interface.
- **`/openpouch:deploy` skill**: workflow knowledge — the shape-based deploy command, verify-before-report, the self-repair loop, resuming from `DEPLOYMENT.md`, and the hand-off block (`tellYourUser`) your human should actually see.

## Install

From the community marketplace:

```
/plugin marketplace add anthropics/claude-plugins-community
/plugin install openpouch@claude-community
```

Or try it directly from this repository:

```bash
claude --plugin-dir path/to/this/repo
```

Then ask Claude Code to *"deploy this and give me a link for my client"* — it runs the deploy, verifies health, and relays the live URL plus a plain-language summary.

## How it works

- **Anonymous by default:** every deploy returns a live `https://<slug>.openpouch.sh` URL; anonymous previews expire after 72 h (the result names the exact date and the ways to keep it).
- **Accounts are optional:** an `OPENPOUCH_API_KEY` (env, or `~/.openpouch/openpouch-run.key`) lifts deploys into your account — apps then stay up as long as they're being used (usage-based rolling expiry). Plans from $15/month: https://openpouch.dev/pricing
- **Static and dynamic:** plain HTML/SPA output is served from the edge; Node apps (Express, Fastify, full-stack) run in real containers with install + build on the server.
- **Honest, machine-readable contracts:** every command has `--json` with published schemas; expiry, ownership, and health are always visible to the agent.

## Links

- Website & docs: https://openpouch.dev · agent entry point: https://openpouch.dev/llms.txt
- Source: https://github.com/openpouch/openpouch (Apache-2.0)
- MCP server package: [`@openpouch/mcp`](https://www.npmjs.com/package/@openpouch/mcp) · CLI: [`openpouch`](https://www.npmjs.com/package/openpouch)
