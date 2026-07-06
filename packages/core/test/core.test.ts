import { describe, expect, it } from "vitest";
import {
  defaultPolicy,
  evaluateAction,
  parseManifest,
  policySchema,
} from "../src/index.js";

const validManifest = {
  version: 0,
  project: { name: "demo-app", repo: "github.com/example/demo-app", framework: "node" },
  build: { buildCommand: "npm run build", startCommand: "npm start" },
  healthcheck: { path: "/healthz", expectStatus: 200, timeoutMs: 5000 },
  env: [
    { name: "DATABASE_URL", required: true },
    { name: "SENTRY_DSN", required: false, environments: ["production"] },
  ],
  environments: {
    preview: { provider: "render", branch: "main" },
    production: { provider: "render", serviceId: "srv-abc123", url: "https://demo-app.example.com" },
  },
};

describe("manifest", () => {
  it("parses a valid manifest and applies defaults", () => {
    const result = parseManifest(validManifest);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.env[0]?.required).toBe(true);
    expect(result.value.environments.production?.serviceId).toBe("srv-abc123");
  });

  it("rejects unknown providers with a path-prefixed error", () => {
    const broken = structuredClone(validManifest) as Record<string, unknown>;
    (broken.environments as Record<string, { provider: string }>).production!.provider = "heroku";
    const result = parseManifest(broken);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join("\n")).toContain("environments.production.provider");
  });

  it("rejects unknown top-level keys (strict format)", () => {
    const result = parseManifest({ ...validManifest, secrets: { DATABASE_URL: "leak!" } });
    expect(result.ok).toBe(false);
  });
});

describe("policy engine", () => {
  const policy = defaultPolicy();

  it("allows read everywhere by default", () => {
    expect(evaluateAction(policy, "preview", "read")).toBe("allowed");
    expect(evaluateAction(policy, "production", "read")).toBe("allowed");
    expect(evaluateAction(policy, "staging", "read")).toBe("allowed");
  });

  it("lets previews deploy autonomously but gates production behind approval", () => {
    expect(evaluateAction(policy, "preview", "deploy-preview")).toBe("allowed");
    expect(evaluateAction(policy, "production", "deploy-production")).toBe("requires-approval");
    expect(evaluateAction(policy, "production", "rollback")).toBe("requires-approval");
  });

  it("denies anything not explicitly granted", () => {
    expect(evaluateAction(policy, "staging", "deploy-production")).toBe("denied");
    expect(evaluateAction(policy, "preview", "deploy-production")).toBe("denied");
  });

  it("requireApproval wins over allow when both list the same action", () => {
    const conflicted = policySchema.parse({
      version: 0,
      environments: {
        production: { allow: ["deploy-production"], requireApproval: ["deploy-production"] },
      },
    });
    expect(evaluateAction(conflicted, "production", "deploy-production")).toBe("requires-approval");
  });
});
