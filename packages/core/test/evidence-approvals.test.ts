import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendDeployment,
  canonicalApprovalPayload,
  findUsableApproval,
  isExpired,
  readEvidence,
  renderDeploymentMd,
  type ApprovalRequest,
  type DeploymentRecord,
} from "../src/index.js";

const record = (over: Partial<DeploymentRecord> = {}): DeploymentRecord => ({
  id: "dep-1",
  environment: "production",
  provider: "render",
  status: "live",
  url: "https://app.example.com",
  commit: "abc1234567",
  deployedAt: "2026-06-12T12:00:00Z",
  rollbackAnchor: "dep-0",
  ...over,
});

describe("evidence io", () => {
  it("appends newest-first and writes both files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openpouch-ev-"));
    await appendDeployment(dir, record({ id: "dep-1", deployedAt: "2026-06-12T10:00:00Z" }));
    await appendDeployment(dir, record({ id: "dep-2", deployedAt: "2026-06-12T11:00:00Z" }));

    const evidence = await readEvidence(dir);
    expect(evidence.deployments.map((d) => d.id)).toEqual(["dep-2", "dep-1"]);

    const md = await readFile(join(dir, "DEPLOYMENT.md"), "utf8");
    expect(md).toContain("Currently live");
    expect(md).toContain("abc1234567".slice(0, 10));
    expect(md).toContain("dep-0"); // rollback anchor visible
  });

  it("renders the latest record per environment plus full history", () => {
    const md = renderDeploymentMd({
      version: 0,
      deployments: [
        record({ id: "dep-3", environment: "production", deployedAt: "2026-06-12T12:00:00Z", approvedBy: "dino" }),
        record({ id: "dep-2", environment: "preview", deployedAt: "2026-06-12T11:00:00Z" }),
        record({ id: "dep-1", environment: "production", deployedAt: "2026-06-12T10:00:00Z" }),
      ],
    });
    expect(md).toContain("| production |");
    expect(md).toContain("| preview |");
    expect(md).toContain("approved by dino");
    // history lists all three (bullets that start with the ISO deployedAt date;
    // the resume-checklist section below also uses `- ` bullets, so match dates)
    expect(md.match(/^- \d{4}-/gm)).toHaveLength(3);
    // resume-after-context-loss checklist is present (Hermes 2026-07-02)
    expect(md).toContain("## Resume after context loss");
    expect(md).toContain("## If the app is unhealthy (self-repair)"); // Hermes 2026-07-04: runbook in the file itself
    expect(md).toContain("openpouch logs --limit 200 --json");
    expect(md).toContain("openpouch verify --json");
    expect(md).toContain(".openpouch/claim.json");
  });
});

describe("approval helpers", () => {
  const req: ApprovalRequest = {
    id: "ab12cd34",
    action: "deploy-production",
    environment: "production",
    serviceId: "srv-1",
    requestedAt: "2026-06-12T10:00:00Z",
    expiresAt: "2026-06-13T10:00:00Z",
    status: "approved",
  };

  it("canonical payload covers all signed fields", () => {
    expect(canonicalApprovalPayload(req)).toBe(
      "ab12cd34|deploy-production|production|srv-1|2026-06-12T10:00:00Z|2026-06-13T10:00:00Z",
    );
  });

  it("findUsableApproval matches only approved, unexpired, exact requests", () => {
    const file = { version: 0 as const, requests: [req] };
    const now = new Date("2026-06-12T12:00:00Z");
    const match = { action: "deploy-production" as const, environment: "production" as const, serviceId: "srv-1" };

    expect(findUsableApproval(file, match, now)?.id).toBe("ab12cd34");
    expect(findUsableApproval(file, { ...match, serviceId: "srv-2" }, now)).toBeUndefined();
    expect(findUsableApproval({ version: 0, requests: [{ ...req, status: "consumed" }] }, match, now)).toBeUndefined();
    expect(findUsableApproval(file, match, new Date("2026-06-14T00:00:00Z"))).toBeUndefined();
  });

  it("isExpired is inclusive at the boundary", () => {
    expect(isExpired(req, new Date("2026-06-13T10:00:00Z"))).toBe(true);
    expect(isExpired(req, new Date("2026-06-13T09:59:59Z"))).toBe(false);
  });
});
