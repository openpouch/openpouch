# Security Policy

openpouch runs untrusted, agent-authored code on its own infrastructure and acts as a deployment broker between agents and live systems. We take security reports seriously and appreciate coordinated disclosure.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately via one of:

1. **GitHub Security Advisories** (preferred): on this repository, go to the **Security** tab → **Report a vulnerability**. This opens a private channel with the maintainers.
2. **Email:** `security@openpouch.dev`.

Please include:

- a description of the issue and its impact,
- the affected component (CLI, MCP server, an adapter, `run-d`/instant lane, or a file format),
- steps to reproduce or a proof of concept,
- the version (`openpouch --version`) and how you installed it.

We aim to acknowledge a report within **3 business days** and to provide a remediation timeline after triage. We will keep you informed of progress and credit you in the advisory unless you ask us not to. Please give us a reasonable window to ship a fix before any public disclosure.

## Supported versions

openpouch is in **technical preview** (`0.2.x`). Security fixes target the latest published `0.2.x` release on npm. There is no long-term-support branch yet; please test against the most recent version before reporting.

| Version | Supported |
|---|---|
| `0.2.x` (latest) | ✅ |
| older / pre-release | ❌ |

## What is in scope

- The published `openpouch` CLI and the MCP server.
- The instant lane / `run-d` host daemon: container isolation, the egress filter, the privilege model (the `op-docker` wrapper), routing, quotas and abuse controls, and the account/API-key subsystem.
- The provider adapters (Render, Vercel) and the secret-handling boundary.
- The open file formats (`deploy.manifest.json`, `deploy.policy.json`, `deploy.evidence.json`) where a malformed file could lead to unsafe behavior.

Especially valuable: **container escapes or host access** from a deployed app, **egress-filter bypass**, **privilege escalation** via the `op-docker` wrapper, any path that **exposes secret values** to an agent / model context / logs, any way an **agent can approve its own production deploy**, and **quota / abuse-control bypass**.

## Out of scope

- Vulnerabilities in third-party providers (Render, Vercel) or in their APIs — report those to the respective vendor.
- Denial of service from unrealistic traffic volumes against the free instant lane (it is rate-, resource-, and TTL-capped by design; report *bypasses* of those caps, not the existence of load).
- Issues that require a compromised local machine or a malicious local operator (the CLI trusts the machine it runs on).
- Missing hardening that is already documented as planned (e.g. gVisor/Firecracker for the instant lane).

## Security posture (how the product is built)

These are design invariants, not aspirations — a report that breaks any of them is a valid vulnerability:

- **Read-only by default.** Previews may be autonomous per policy; **production requires a signed, single-use approval granted by a human in an interactive terminal.** There is deliberately **no agent-accessible approve** path in any interface.
- **No destructive action class in the governed/production lane.** The core policy has no delete/destroy action class. The only delete is owner-scoped self-service removal of one's own ephemeral instant preview (`openpouch delete` / the `openpouch_delete` MCP tool) — server-verified as the caller's own app, not approval-gated by design (an ephemeral preview is re-creatable and is not a governed-production action).
- **Secret values never enter model context, output, logs, or evidence.** Environment variables are reported by **name and presence only**.
- **Untrusted code runs hardened.** The instant lane builds and runs apps in locked-down containers (capability drop, no-new-privileges, resource limits) behind an **egress filter** (DNS + HTTP/HTTPS only), with short TTLs, a global capacity cap, report + operator takedown, and per-account quotas. Abuse is controlled with **agent-compatible** means (keys, quotas, rate/resource/egress limits, takedown) — **never** CAPTCHAs or human-verification walls.
- **Every action is audited**; deployment truth is written back to the repo.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/INSTANT-LANE.md](docs/INSTANT-LANE.md) for the technical detail behind these guarantees.
