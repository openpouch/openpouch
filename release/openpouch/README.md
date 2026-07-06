# openpouch 🦘

**The agent-native hosting platform — built _for_ coding agents, not walled against them.** Deploy any folder to a live URL in one command — no account, no dashboard, no CAPTCHA:

```bash
npx openpouch deploy
```

> **Status: technical preview.** `openpouch deploy` serves **static** sites (HTML/SPAs/build output) **and runs real Node.js apps** in a hardened container — autonomously, from any agent or terminal. Previews are ephemeral (unclaimed ones vanish after 72 h); durable production hosting and self-service billing are on the way. Feedback welcome on GitHub.

You get a live `https://<slug>.openpouch.sh` URL plus a claim link. The agent deploys autonomously; a human claims it via the link to keep it. openpouch writes the deployment truth (`deploy.manifest.json`, `deploy.evidence.json`, `DEPLOYMENT.md`) back into your repo, so any agent can resume after context loss.

> **Framework frontends (React/Vite/Next/Svelte…): deploy the _built output_, not the source folder.** Build first, then point `deploy` at the build directory:
> ```bash
> npm run build
> npx openpouch deploy dist     # Vite → dist/ · CRA → build/ · Next static export → out/
> ```
> If you run `openpouch deploy` in an unbuilt frontend root, it **stops and tells you which folder to deploy** instead of silently shipping source that won't run (use `openpouch deploy .` to force the current folder). Server-side build-on-deploy is live — pass the source folder explicitly (`openpouch deploy .`) and the server runs `npm run build` for you, for both full-stack apps (an Express/Node server with a build step) and unbuilt static SPAs (a Vite/CRA frontend with no server → built, then served as files).

## Accounts (optional)

Start anonymous, or create a free account for higher limits — entirely from the agent, no dashboard:

```bash
npx openpouch signup --email you@example.com    # or: --github
npx openpouch activate --account <id> --token <token-from-email>
npx openpouch whoami --json                      # your tier + current usage
```

Your API key is stored locally; deploys then run under your account and quota. Abuse is controlled with accounts, quotas, rate limits and an egress filter — **never** by asking a machine to prove it's human.

## Bring your own provider

Already on Render or Vercel? `openpouch init` detects your project and maps the service; then `openpouch preview` / `openpouch prod` run a governed pipeline — previews autonomous, production gated behind a human approval. Agents can never self-approve production.

## Commands

`deploy` · `list` · `delete` · `signup` · `activate` · `whoami` · `init` · `inspect` · `plan` · `preview` · `prod` · `approve` · `verify` · `logs` · `rollback` · `feedback` — every command supports `--json` and stable exit codes, so any agent harness with a shell can drive it. An MCP server exposes the same tools.

- Source & docs: https://github.com/openpouch/openpouch
- License: Apache-2.0
