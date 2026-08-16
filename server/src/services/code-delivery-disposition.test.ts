import { describe, expect, it } from "vitest";
import {
  buildFinishCodeDeliveryHandoffIdempotencyKey,
  evaluateCodeDeliveryEvidence,
  orderCodeDeliveryHandoffCandidateIds,
  resolveCodeDeliveryRequiredStage,
  runDeclaresCodeDeliveryHandoff,
} from "./code-delivery-disposition.js";

const workspace = {
  id: "workspace-1",
  companyId: "company-1",
  projectId: "project-1",
  sourceIssueId: "issue-1",
  strategyType: "git_worktree",
  providerType: "git_worktree",
  repoUrl: "https://github.com/example/repo.git",
  branchName: "pap/issue-1",
};

function product(input: Partial<{
  id: string;
  executionWorkspaceId: string | null;
  type: string;
  provider: string;
  externalId: string | null;
  url: string | null;
  status: string;
  metadata: Record<string, unknown> | null;
}> = {}) {
  return {
    id: input.id ?? "product-1",
    executionWorkspaceId: input.executionWorkspaceId ?? workspace.id,
    type: input.type ?? "commit",
    provider: input.provider ?? "paperclip",
    externalId: input.externalId ?? "abc123",
    url: input.url ?? null,
    status: input.status ?? "active",
    metadata: input.metadata ?? null,
  };
}

describe("code delivery disposition", () => {
  it("does not treat a local commit or local branch label as remote delivery", () => {
    const assessment = evaluateCodeDeliveryEvidence({
      workspace,
      workProducts: [
        product({ type: "commit", externalId: "abc123" }),
        product({ id: "branch", type: "branch", externalId: "pap/issue-1" }),
      ],
    });

    expect(assessment).toMatchObject({
      applicable: true,
      complete: false,
      requiredStage: "pull_request",
      evidence: {
        localImplementation: true,
        remoteBranch: false,
        pullRequest: false,
        merged: false,
        deployed: false,
      },
      missingEvidence: ["remote_branch", "pull_request"],
    });
  });

  it("accepts a structured GitHub pull request as the default delivery receipt", () => {
    const assessment = evaluateCodeDeliveryEvidence({
      workspace,
      workProducts: [product({
        type: "pull_request",
        provider: "github",
        externalId: "8421",
        url: "https://github.com/example/repo/pull/8421",
        status: "ready_for_review",
      })],
    });

    expect(assessment).toMatchObject({
      applicable: true,
      complete: true,
      evidence: { remoteBranch: true, pullRequest: true },
      missingEvidence: [],
    });
  });

  it("does not accept a URL-shaped custom artifact as a GitHub PR receipt", () => {
    const assessment = evaluateCodeDeliveryEvidence({
      workspace,
      workProducts: [product({
        type: "pull_request",
        provider: "paperclip",
        externalId: "8421",
        url: "https://example.test/not-a-provider-verified-pr/8421",
        status: "ready_for_review",
      })],
    });
    expect(assessment).toMatchObject({ applicable: true, complete: false });
  });

  it("requires cumulative merge and production evidence for deployed completion", () => {
    const pullRequest = product({
      type: "pull_request",
      provider: "github",
      externalId: "8421",
      url: "https://github.com/example/repo/pull/8421",
      status: "merged",
      metadata: { mergedAt: "2026-08-16T10:00:00.000Z" },
    });
    const staging = product({
      id: "staging",
      type: "runtime_service",
      provider: "vercel",
      url: "https://preview.example.test",
      status: "active",
      metadata: { environment: "staging" },
    });
    const incomplete = evaluateCodeDeliveryEvidence({
      workspace,
      pullRequestPolicy: { requireDeploymentBeforeDone: true },
      workProducts: [pullRequest, staging],
    });
    expect(incomplete).toMatchObject({
      applicable: true,
      complete: false,
      requiredStage: "deployed",
      missingEvidence: ["deployed"],
    });

    const complete = evaluateCodeDeliveryEvidence({
      workspace,
      pullRequestPolicy: { requireDeploymentBeforeDone: true },
      workProducts: [
        pullRequest,
        product({
          id: "production",
          type: "runtime_service",
          provider: "vercel",
          url: "https://app.example.test",
          status: "active",
          metadata: { environment: "production" },
        }),
      ],
    });
    expect(complete).toMatchObject({ applicable: true, complete: true, missingEvidence: [] });
  });

  it("honors an explicit project opt-out", () => {
    expect(resolveCodeDeliveryRequiredStage({ prMode: "none" })).toBeNull();
    expect(evaluateCodeDeliveryEvidence({
      workspace,
      pullRequestPolicy: { mode: "disabled" },
      workProducts: [],
    })).toEqual({ applicable: false, reason: "delivery_guard_disabled" });
  });

  it("builds a stage-scoped idempotency key for the canonical handoff", () => {
    expect(buildFinishCodeDeliveryHandoffIdempotencyKey({
      issueId: "issue-1",
      sourceRunId: "run-1",
      requiredStage: "pull_request",
    })).toBe("finish_code_delivery_handoff:issue-1:run-1:pull_request:1");
  });

  it("recognizes a persisted declaration that DevOps owns the remaining remote step", () => {
    expect(runDeclaresCodeDeliveryHandoff({
      nextAction: "Push e abertura do PR são exclusivos do DevOps; encaminhar a branch existente.",
    })).toBe(true);
    expect(runDeclaresCodeDeliveryHandoff({
      resultJson: {
        codeDeliveryHandoff: { required: true, ownerRole: "pr_governance" },
      },
    })).toBe(true);
    expect(runDeclaresCodeDeliveryHandoff({
      nextAction: "Executar os testes restantes localmente.",
    })).toBe(false);
  });

  it("orders real governance, DevOps, and the full manager ladder without duplicates", () => {
    expect(orderCodeDeliveryHandoffCandidateIds({
      sourceAgentId: "source",
      sourceReportsTo: "paused-manager",
      governanceAgentIds: ["foreign", "governance", "devops", "governance", "source"],
      companyAgents: [
        { id: "source", role: "engineer", reportsTo: "paused-manager" },
        { id: "governance", role: "qa", reportsTo: null },
        { id: "devops", role: "DevOps", reportsTo: null },
        { id: "paused-manager", role: "general", reportsTo: "senior-manager" },
        { id: "senior-manager", role: "general", reportsTo: "paused-manager" },
        { id: "cto", role: "cto", reportsTo: null },
      ],
    })).toEqual([
      "governance",
      "devops",
      "paused-manager",
      "senior-manager",
      "cto",
    ]);
  });
});
