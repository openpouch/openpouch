import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import {
  APPROVALS_DIR,
  APPROVALS_FILENAME,
  approvalsFileSchema,
  canonicalApprovalPayload,
  type ActionClass,
  type ApprovalRequest,
  type ApprovalsFile,
  type EnvironmentName,
} from "@openpouch/core";

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 h

export async function loadApprovals(cwd: string): Promise<ApprovalsFile> {
  try {
    const raw = await readFile(join(cwd, APPROVALS_FILENAME), "utf8");
    return approvalsFileSchema.parse(JSON.parse(raw));
  } catch {
    return { version: 0, requests: [] };
  }
}

export async function saveApprovals(cwd: string, file: ApprovalsFile): Promise<void> {
  await mkdir(join(cwd, APPROVALS_DIR), { recursive: true });
  await ensureGitignored(cwd);
  await writeFile(
    join(cwd, APPROVALS_FILENAME),
    `${JSON.stringify(approvalsFileSchema.parse(file), null, 2)}\n`,
    "utf8",
  );
}

/**
 * Ensure `.openpouch/` is gitignored. That directory holds local runtime state
 * — approval requests, and the private claim link (.openpouch/claim.json) — none
 * of which belongs in repo history. Shared with the instant lane (Fix B).
 */
export async function ensureGitignored(cwd: string): Promise<void> {
  const path = join(cwd, ".gitignore");
  let content = "";
  try {
    content = await readFile(path, "utf8");
  } catch {
    // no .gitignore yet
  }
  if (!content.split("\n").some((line) => line.trim() === ".openpouch/")) {
    const addition = `${content.length > 0 && !content.endsWith("\n") ? "\n" : ""}.openpouch/\n`;
    await writeFile(path, content + addition, "utf8");
  }
}

export function newApprovalRequest(
  match: { action: ActionClass; environment: EnvironmentName; serviceId: string },
  now: Date,
): ApprovalRequest {
  return {
    id: randomBytes(4).toString("hex"),
    action: match.action,
    environment: match.environment,
    serviceId: match.serviceId,
    requestedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + DEFAULT_TTL_MS).toISOString(),
    status: "pending",
  };
}

/**
 * The approver secret lives in the HUMAN's home, outside the repo.
 * Signatures make approvals tamper-evident; see BUSINESS-RULES.md for the
 * honest local-soft-gate vs. hosted-hard-gate distinction.
 */
export async function getApproverSecret(createIfMissing: boolean, home?: string): Promise<string | undefined> {
  const dir = join(home ?? homedir(), ".openpouch");
  const path = join(dir, "approver.secret");
  try {
    const existing = (await readFile(path, "utf8")).trim();
    if (existing.length > 0) return existing;
  } catch {
    // fall through
  }
  if (!createIfMissing) return undefined;
  const secret = randomBytes(32).toString("hex");
  await mkdir(dir, { recursive: true });
  await writeFile(path, `${secret}\n`, { mode: 0o600 });
  return secret;
}

export function signApproval(request: ApprovalRequest, secret: string): string {
  return createHmac("sha256", secret).update(canonicalApprovalPayload(request)).digest("hex");
}

export function signatureValid(request: ApprovalRequest, secret: string): boolean {
  if (request.signature === undefined) return false;
  const expected = Buffer.from(signApproval(request, secret), "hex");
  const actual = Buffer.from(request.signature, "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function approverName(): string {
  try {
    return userInfo().username;
  } catch {
    return "unknown";
  }
}
