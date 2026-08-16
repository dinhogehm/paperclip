import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  executionWorkspaces,
  heartbeatRuns,
  issueWorkProducts,
  issues,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
const mockAssessIssueCodeDeliveryDisposition = vi.hoisted(() => vi.fn());
vi.mock("../services/code-delivery-disposition.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/code-delivery-disposition.js")>();
  mockAssessIssueCodeDeliveryDisposition.mockImplementation(actual.assessIssueCodeDeliveryDisposition);
  return {
    ...actual,
    assessIssueCodeDeliveryDisposition: mockAssessIssueCodeDeliveryDisposition,
  };
});
import { issueService } from "../services/issues.js";
import {
  CODE_DELIVERY_DISPOSITION_REJECTED_ACTION,
  CODE_DELIVERY_EVIDENCE_REQUIRED_CODE,
} from "../services/code-delivery-disposition.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("issueService code delivery disposition", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-code-delivery-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    mockAssessIssueCodeDeliveryDisposition.mockClear();
    await db.delete(issueWorkProducts);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(projects);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("keeps agent-owned code work in progress until a remote PR is persisted", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const issueId = randomUUID();
    const executionWorkspaceId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Delivery guard",
      issuePrefix: "DLV",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Remote delivery",
      status: "in_progress",
      executionWorkspacePolicy: {
        enabled: true,
        pullRequestPolicy: { prMode: "agent_may_open" },
      },
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Implementation engineer",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      invocationSource: "automation",
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "DLV-1 worktree",
      status: "active",
      providerType: "git_worktree",
      repoUrl: "https://github.com/example/repo.git",
      branchName: "pap/dlv-1",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      title: "Ship a remote change",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      executionWorkspaceId,
    });
    await db
      .update(executionWorkspaces)
      .set({ sourceIssueId: issueId })
      .where(eq(executionWorkspaces.id, executionWorkspaceId));

    const svc = issueService(db);
    await expect(svc.update(issueId, {
      status: "done",
      actorAgentId: agentId,
      actorRunId: runId,
    })).rejects.toMatchObject({
      status: 422,
      details: {
        code: CODE_DELIVERY_EVIDENCE_REQUIRED_CODE,
        requiredStage: "pull_request",
        missingEvidence: ["remote_branch", "pull_request"],
      },
    });
    await expect(svc.update(issueId, {
      status: "done",
      actorAgentId: agentId,
      actorRunId: runId,
    })).rejects.toMatchObject({
      status: 422,
      details: { code: CODE_DELIVERY_EVIDENCE_REQUIRED_CODE },
    });

    const rejectedIssue = await db
      .select({ status: issues.status, completedAt: issues.completedAt })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(rejectedIssue).toEqual({ status: "in_progress", completedAt: null });
    const rejectionEvents = await db
      .select({ action: activityLog.action, runId: activityLog.runId })
      .from(activityLog)
      .where(eq(activityLog.action, CODE_DELIVERY_DISPOSITION_REJECTED_ACTION));
    expect(rejectionEvents).toEqual([{ action: CODE_DELIVERY_DISPOSITION_REJECTED_ACTION, runId }]);

    await db.insert(issueWorkProducts).values({
      companyId,
      projectId,
      issueId,
      executionWorkspaceId,
      type: "pull_request",
      provider: "github",
      externalId: "8421",
      title: "PR #8421",
      url: "https://github.com/example/repo/pull/8421",
      status: "ready_for_review",
    });

    const completed = await svc.update(issueId, {
      status: "done",
      actorAgentId: agentId,
      actorRunId: runId,
    });
    expect(completed?.status).toBe("done");
    expect(completed?.completedAt).toBeInstanceOf(Date);
  });

  it("persists the rejection after the locked recheck catches vanished evidence", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const issueId = randomUUID();
    const executionWorkspaceId = randomUUID();
    const evidence = {
      localImplementation: true,
      remoteBranch: true,
      pullRequest: true,
      merged: false,
      deployed: false,
    };

    await db.insert(companies).values({
      id: companyId,
      name: "Locked delivery guard",
      issuePrefix: "LCK",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Locked delivery",
      status: "in_progress",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Implementation engineer",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      invocationSource: "automation",
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "LCK-1 worktree",
      providerType: "git_worktree",
      repoUrl: "https://github.com/example/repo.git",
      branchName: "pap/lck-1",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      title: "Evidence disappears before persistence",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      executionWorkspaceId,
    });

    mockAssessIssueCodeDeliveryDisposition
      .mockResolvedValueOnce({
        applicable: true,
        complete: true,
        requiredStage: "pull_request",
        executionWorkspaceId,
        branchName: "pap/lck-1",
        evidence,
        missingEvidence: [],
      })
      .mockResolvedValueOnce({
        applicable: true,
        complete: false,
        requiredStage: "pull_request",
        executionWorkspaceId,
        branchName: "pap/lck-1",
        evidence: { ...evidence, remoteBranch: false, pullRequest: false },
        missingEvidence: ["remote_branch", "pull_request"],
      });

    await expect(issueService(db).update(issueId, {
      status: "done",
      actorAgentId: agentId,
      actorRunId: runId,
    })).rejects.toMatchObject({
      status: 422,
      details: { code: CODE_DELIVERY_EVIDENCE_REQUIRED_CODE },
    });

    expect(await db
      .select({ action: activityLog.action, runId: activityLog.runId })
      .from(activityLog)
      .where(eq(activityLog.action, CODE_DELIVERY_DISPOSITION_REJECTED_ACTION)))
      .toEqual([{ action: CODE_DELIVERY_DISPOSITION_REJECTED_ACTION, runId }]);
    expect(await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, issueId)))
      .toEqual([{ status: "in_progress" }]);
  });
});
