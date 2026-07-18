export {
  ENVIRONMENT_NAMES,
  MANIFEST_FILENAME,
  PROVIDER_IDS,
  environmentConfigSchema,
  environmentNameSchema,
  envVarRequirementSchema,
  healthcheckSchema,
  manifestSchema,
  parseManifest,
  providerIdSchema,
} from "./manifest.js";
export type {
  EnvVarRequirement,
  EnvironmentConfig,
  EnvironmentName,
  Healthcheck,
  Manifest,
  ParseResult,
  ProviderId,
} from "./manifest.js";

export {
  ACTION_CLASSES,
  POLICY_FILENAME,
  actionClassSchema,
  defaultPolicy,
  environmentPolicySchema,
  evaluateAction,
  policySchema,
} from "./policy.js";
export type { ActionClass, EnvironmentPolicy, Policy, PolicyDecision } from "./policy.js";

export {
  EVIDENCE_FILENAME,
  deploymentRecordSchema,
  evidenceSchema,
  smokeCheckSchema,
} from "./evidence.js";
export type { DeploymentRecord, Evidence, SmokeCheck } from "./evidence.js";

export {
  DEPLOYMENT_MD_FILENAME,
  appendDeployment,
  readEvidence,
  renderDeploymentMd,
  writeEvidence,
} from "./evidence-io.js";

export {
  APPROVALS_DIR,
  APPROVALS_FILENAME,
  approvalRequestSchema,
  approvalStatusSchema,
  approvalsFileSchema,
  canonicalApprovalPayload,
  findUsableApproval,
  isExpired,
} from "./approvals.js";
export type { ApprovalRequest, ApprovalStatus, ApprovalsFile } from "./approvals.js";

export type {
  AdapterFactory,
  DeploySummary,
  EnvVarStatus,
  LogLine,
  ProviderAdapter,
  ServiceSummary,
} from "./adapter.js";
