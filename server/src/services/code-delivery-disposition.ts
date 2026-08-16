import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  executionWorkspaces,
  issueWorkProducts,
  projects,
  type issues,
} from "@paperclipai/db";
import { logActivity } from "./activity-log.js";

export const CODE_DELIVERY_EVIDENCE_REQUIRED_CODE = "code_delivery_evidence_required";
export const CODE_DELIVERY_DISPOSITION_REJECTED_ACTION = "issue.code_delivery_disposition_rejected";
export const FINISH_CODE_DELIVERY_HANDOFF_REASON = "finish_code_delivery_handoff";

export type CodeDeliveryRequiredStage =
  | "remote_branch"
  | "pull_request"
  | "merged"
  | "deployed";

type DeliveryWorkspace = Pick<
  typeof executionWorkspaces.$inferSelect,
  | "id"
  | "companyId"
  | "projectId"
  | "sourceIssueId"
  | "strategyType"
  | "providerType"
  | "repoUrl"
  | "branchName"
>;

type DeliveryWorkProduct = Pick<
  typeof issueWorkProducts.$inferSelect,
  | "id"
  | "executionWorkspaceId"
  | "type"
  | "provider"
  | "externalId"
  | "url"
  | "status"
  | "metadata"
>;

type DeliveryIssue = Pick<
  typeof issues.$inferSelect,
  "id" | "companyId" | "projectId" | "executionWorkspaceId"
>;

export type CodeDeliveryEvidence = {
  localImplementation: boolean;
  remoteBranch: boolean;
  pullRequest: boolean;
  merged: boolean;
  deployed: boolean;
};

export type CodeDeliveryDispositionAssessment =
  | {
      applicable: false;
      reason: "no_git_delivery_workspace" | "delivery_guard_disabled";
    }
  | {
      applicable: true;
      complete: boolean;
      requiredStage: CodeDeliveryRequiredStage;
      executionWorkspaceId: string;
      branchName: string | null;
      evidence: CodeDeliveryEvidence;
      missingEvidence: CodeDeliveryRequiredStage[];
    };

export type CodeDeliveryEvidenceRequiredDetails = {
  code: typeof CODE_DELIVERY_EVIDENCE_REQUIRED_CODE;
  requiredStage: CodeDeliveryRequiredStage;
  executionWorkspaceId: string;
  branchName: string | null;
  evidence: CodeDeliveryEvidence;
  missingEvidence: CodeDeliveryRequiredStage[];
};

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readBoolean(value: unknown) {
  return typeof value === "boolean" ? value : null;
}

export function readCodeDeliveryEvidenceRequiredDetails(
  errorOrDetails: unknown,
): CodeDeliveryEvidenceRequiredDetails | null {
  const candidate = readRecord(errorOrDetails);
  const details = candidate.details && typeof candidate.details === "object"
    ? readRecord(candidate.details)
    : candidate;
  if (details.code !== CODE_DELIVERY_EVIDENCE_REQUIRED_CODE) return null;
  const requiredStage = normalizeRequiredStage(details.requiredStage);
  const executionWorkspaceId = readString(details.executionWorkspaceId);
  const evidence = readRecord(details.evidence);
  if (!requiredStage || !executionWorkspaceId) return null;
  const missingEvidence = Array.isArray(details.missingEvidence)
    ? details.missingEvidence
      .map(normalizeRequiredStage)
      .filter((stage): stage is CodeDeliveryRequiredStage => stage !== null)
    : [];
  return {
    code: CODE_DELIVERY_EVIDENCE_REQUIRED_CODE,
    requiredStage,
    executionWorkspaceId,
    branchName: readString(details.branchName),
    evidence: {
      localImplementation: evidence.localImplementation === true,
      remoteBranch: evidence.remoteBranch === true,
      pullRequest: evidence.pullRequest === true,
      merged: evidence.merged === true,
      deployed: evidence.deployed === true,
    },
    missingEvidence,
  };
}

export async function persistCodeDeliveryDispositionRejection(
  db: Db,
  input: {
    companyId: string;
    issueId: string;
    actorAgentId: string;
    sourceRunId?: string | null;
    details: CodeDeliveryEvidenceRequiredDetails;
  },
) {
  const existing = input.sourceRunId
    ? await db
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, input.companyId),
        eq(activityLog.entityType, "issue"),
        eq(activityLog.entityId, input.issueId),
        eq(activityLog.runId, input.sourceRunId),
        eq(activityLog.action, CODE_DELIVERY_DISPOSITION_REJECTED_ACTION),
      ))
      .limit(1)
      .then((rows) => rows[0] ?? null)
    : null;
  if (existing) return existing;
  return logActivity(db, {
    companyId: input.companyId,
    actorType: "agent",
    actorId: input.actorAgentId,
    agentId: input.actorAgentId,
    runId: input.sourceRunId ?? null,
    action: CODE_DELIVERY_DISPOSITION_REJECTED_ACTION,
    entityType: "issue",
    entityId: input.issueId,
    details: input.details,
  });
}

function normalizePolicyToken(value: unknown) {
  return readString(value)?.toLowerCase().replace(/[\s-]+/g, "_") ?? null;
}

function normalizeRequiredStage(value: unknown): CodeDeliveryRequiredStage | null {
  const token = normalizePolicyToken(value);
  if (!token) return null;
  if (["branch", "remote_branch", "pushed", "push"].includes(token)) return "remote_branch";
  if (["pr", "pull_request", "open_pr", "opened_pr"].includes(token)) return "pull_request";
  if (["merge", "merged", "merged_pr"].includes(token)) return "merged";
  if (["deploy", "deployed", "production", "production_deploy"].includes(token)) return "deployed";
  return null;
}

export function orderCodeDeliveryHandoffCandidateIds(input: {
  sourceAgentId: string;
  sourceReportsTo: string | null;
  governanceAgentIds: string[];
  companyAgents: Array<{
    id: string;
    role: string | null;
    reportsTo: string | null;
  }>;
}) {
  const byId = new Map(input.companyAgents.map((candidate) => [candidate.id, candidate]));
  const deliveryRoles = new Set(["devops", "release_manager", "platform_engineer"]);
  const executiveRoles = new Set(["cto", "ceo"]);
  const role = (candidate: { role: string | null }) => normalizePolicyToken(candidate.role) ?? "";
  const managerChain: string[] = [];
  const managerSeen = new Set<string>();
  let managerId = input.sourceReportsTo;
  while (managerId && !managerSeen.has(managerId)) {
    managerSeen.add(managerId);
    const manager = byId.get(managerId);
    if (!manager) break;
    managerChain.push(manager.id);
    managerId = manager.reportsTo;
  }

  const ordered = [
    ...input.governanceAgentIds,
    ...input.companyAgents.filter((candidate) => deliveryRoles.has(role(candidate))).map((candidate) => candidate.id),
    ...managerChain,
    ...input.companyAgents.filter((candidate) => executiveRoles.has(role(candidate))).map((candidate) => candidate.id),
  ];
  const seen = new Set<string>();
  return ordered.filter((candidateId) => {
    if (
      candidateId === input.sourceAgentId ||
      seen.has(candidateId) ||
      !byId.has(candidateId)
    ) return false;
    seen.add(candidateId);
    return true;
  });
}

export function resolveCodeDeliveryRequiredStage(
  pullRequestPolicy: Record<string, unknown> | null | undefined,
): CodeDeliveryRequiredStage | null {
  const policy = readRecord(pullRequestPolicy);
  const mode = normalizePolicyToken(policy.prMode) ?? normalizePolicyToken(policy.mode);
  if (
    mode === "none" ||
    mode === "disabled" ||
    readBoolean(policy.enforceDeliveryDisposition) === false ||
    readBoolean(policy.requireDeliveryEvidenceBeforeDone) === false
  ) {
    return null;
  }

  if (
    readBoolean(policy.requireDeploymentBeforeDone) === true ||
    readBoolean(policy.requireProductionDeploymentBeforeDone) === true
  ) {
    return "deployed";
  }
  if (readBoolean(policy.requireMergeBeforeDone) === true) return "merged";

  const configured = [
    policy.doneRequires,
    policy.completionStage,
    policy.requiredDeliveryStage,
  ].map(normalizeRequiredStage).find((stage): stage is CodeDeliveryRequiredStage => stage !== null);
  if (configured) return configured;

  // A git worktree is an implementation workspace, not a delivery receipt.
  // Unless the project explicitly opts out above, a remote PR is the smallest
  // durable artifact that proves another owner can review and finish the work.
  return "pull_request";
}

function isHttpUrl(value: string | null) {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

function isUsableStatus(status: string) {
  return !["failed", "closed", "archived"].includes(status.toLowerCase());
}

function hasStructuredRemoteBranchEvidence(product: DeliveryWorkProduct) {
  if (product.type !== "branch" || !isUsableStatus(product.status)) return false;
  const metadata = readRecord(product.metadata);
  return product.provider.toLowerCase() === "github" &&
    Boolean(readString(product.externalId)) &&
    (
      isHttpUrl(product.url) ||
      metadata.remote === true ||
      Boolean(readString(metadata.remoteRef)) ||
      Boolean(readString(metadata.remoteUrl)) ||
      Boolean(readString(metadata.remoteBranch))
    );
}

function hasLocalImplementationEvidence(product: DeliveryWorkProduct) {
  return (product.type === "commit" || product.type === "branch") && isUsableStatus(product.status);
}

function hasStructuredPullRequestEvidence(product: DeliveryWorkProduct) {
  if (product.type !== "pull_request" || !isUsableStatus(product.status)) return false;
  return product.provider.toLowerCase() === "github" &&
    Boolean(readString(product.externalId)) &&
    isHttpUrl(product.url);
}

function hasStructuredMergeEvidence(product: DeliveryWorkProduct) {
  if (product.type !== "pull_request") return false;
  const metadata = readRecord(product.metadata);
  return product.status.toLowerCase() === "merged" ||
    normalizePolicyToken(metadata.state) === "merged" ||
    Boolean(readString(metadata.mergedAt)) ||
    Boolean(readString(metadata.mergeCommitSha));
}

function isProductionMetadata(metadata: Record<string, unknown>) {
  if (metadata.production === true) return true;
  return [
    metadata.environment,
    metadata.environmentName,
    metadata.deploymentEnvironment,
    metadata.target,
    metadata.stage,
  ].some((value) => {
    const token = normalizePolicyToken(value);
    return token === "production" || token === "prod";
  });
}

function hasStructuredProductionDeploymentEvidence(product: DeliveryWorkProduct) {
  if (
    product.type !== "preview_url" &&
    product.type !== "runtime_service" &&
    product.type !== "artifact"
  ) return false;
  if (!isUsableStatus(product.status) || !isHttpUrl(product.url)) return false;
  return isProductionMetadata(readRecord(product.metadata));
}

export function evaluateCodeDeliveryEvidence(input: {
  workspace: DeliveryWorkspace;
  pullRequestPolicy?: Record<string, unknown> | null;
  workProducts: DeliveryWorkProduct[];
}): CodeDeliveryDispositionAssessment {
  const isGitDeliveryWorkspace =
    input.workspace.strategyType === "git_worktree" ||
    input.workspace.providerType === "git_worktree";
  if (!isGitDeliveryWorkspace || !input.workspace.repoUrl || !input.workspace.branchName) {
    return { applicable: false, reason: "no_git_delivery_workspace" };
  }

  const requiredStage = resolveCodeDeliveryRequiredStage(input.pullRequestPolicy);
  if (!requiredStage) return { applicable: false, reason: "delivery_guard_disabled" };

  const workspaceProducts = input.workProducts.filter((product) =>
    product.executionWorkspaceId === null || product.executionWorkspaceId === input.workspace.id,
  );
  const pullRequest = workspaceProducts.some(hasStructuredPullRequestEvidence);
  const merged = workspaceProducts.some(hasStructuredMergeEvidence);
  const deployed = workspaceProducts.some(hasStructuredProductionDeploymentEvidence);
  const remoteBranch = pullRequest || workspaceProducts.some(hasStructuredRemoteBranchEvidence);
  const localImplementation = workspaceProducts.some(hasLocalImplementationEvidence);
  const evidence: CodeDeliveryEvidence = { localImplementation, remoteBranch, pullRequest, merged, deployed };

  const requiredStages: CodeDeliveryRequiredStage[] = requiredStage === "remote_branch"
    ? ["remote_branch"]
    : requiredStage === "pull_request"
      ? ["remote_branch", "pull_request"]
      : requiredStage === "merged"
        ? ["remote_branch", "pull_request", "merged"]
        : ["remote_branch", "pull_request", "merged", "deployed"];
  const missingEvidence = requiredStages.filter((stage) => !evidence[
    stage === "remote_branch"
      ? "remoteBranch"
      : stage === "pull_request"
        ? "pullRequest"
        : stage
  ]);

  return {
    applicable: true,
    complete: missingEvidence.length === 0,
    requiredStage,
    executionWorkspaceId: input.workspace.id,
    branchName: input.workspace.branchName,
    evidence,
    missingEvidence,
  };
}

export function runDeclaresCodeDeliveryHandoff(run: {
  nextAction?: string | null;
  resultJson?: unknown;
}) {
  const result = readRecord(run.resultJson);
  const structuredHandoff = readRecord(result.codeDeliveryHandoff);
  if (
    structuredHandoff.required === true &&
    ["devops", "release_manager", "pr_governance"].includes(normalizePolicyToken(structuredHandoff.ownerRole) ?? "")
  ) return true;

  const text = [
    readString(run.nextAction),
    readString(result.nextAction),
    readString(result.summary),
    readString(result.result),
    readString(result.message),
  ].filter((value): value is string => Boolean(value)).join("\n");
  if (!text) return false;
  const namesExternalOwner = /\b(devops|release[\s_-]*(?:manager|engineering)?|pr[\s_-]*governance|governan[çc]a)\b/i.test(text);
  const namesRemoteDelivery = /\b(push|pull[\s_-]*request|pr\b|merge|deploy|publica(?:r|ç[ãa]o)?|produ[çc][ãa]o)\b/i.test(text);
  return namesExternalOwner && namesRemoteDelivery;
}

export async function assessIssueCodeDeliveryDisposition(
  db: Db,
  issue: DeliveryIssue,
): Promise<CodeDeliveryDispositionAssessment> {
  const attachedWorkspace = issue.executionWorkspaceId
    ? await db
      .select()
      .from(executionWorkspaces)
      .where(and(
        eq(executionWorkspaces.id, issue.executionWorkspaceId),
        eq(executionWorkspaces.companyId, issue.companyId),
      ))
      .then((rows) => rows[0] ?? null)
    : null;
  const workspace = attachedWorkspace ?? await db
    .select()
    .from(executionWorkspaces)
    .where(and(
      eq(executionWorkspaces.companyId, issue.companyId),
      eq(executionWorkspaces.sourceIssueId, issue.id),
    ))
    .orderBy(desc(executionWorkspaces.createdAt))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!workspace) return { applicable: false, reason: "no_git_delivery_workspace" };

  const projectId = issue.projectId ?? workspace.projectId;
  const [project, workProducts] = await Promise.all([
    db
      .select({ executionWorkspacePolicy: projects.executionWorkspacePolicy })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.companyId, issue.companyId)))
      .then((rows) => rows[0] ?? null),
    db
      .select({
        id: issueWorkProducts.id,
        executionWorkspaceId: issueWorkProducts.executionWorkspaceId,
        type: issueWorkProducts.type,
        provider: issueWorkProducts.provider,
        externalId: issueWorkProducts.externalId,
        url: issueWorkProducts.url,
        status: issueWorkProducts.status,
        metadata: issueWorkProducts.metadata,
      })
      .from(issueWorkProducts)
      .where(and(
        eq(issueWorkProducts.companyId, issue.companyId),
        eq(issueWorkProducts.issueId, issue.id),
      )),
  ]);
  const executionPolicy = readRecord(project?.executionWorkspacePolicy);
  const pullRequestPolicy = readRecord(executionPolicy.pullRequestPolicy);
  return evaluateCodeDeliveryEvidence({
    workspace,
    pullRequestPolicy,
    workProducts,
  });
}

export function buildFinishCodeDeliveryHandoffIdempotencyKey(input: {
  issueId: string;
  sourceRunId: string;
  requiredStage: CodeDeliveryRequiredStage;
}) {
  return [
    FINISH_CODE_DELIVERY_HANDOFF_REASON,
    input.issueId,
    input.sourceRunId,
    input.requiredStage,
    "1",
  ].join(":");
}
