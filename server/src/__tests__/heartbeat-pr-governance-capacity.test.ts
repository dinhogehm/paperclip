import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentRuntimeState,
  agentTaskSessions,
  agentWakeupRequests,
  companies,
  companySkills,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockAdapterExecute = vi.hoisted(() => vi.fn());

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres PR governance capacity tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type ExecutionResult = {
  exitCode: number;
  signal: null;
  timedOut: false;
  errorMessage: null;
  summary: string;
  provider: string;
  model: string;
};

function successfulExecutionResult(): ExecutionResult {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Completed capacity test run.",
    provider: "test",
    model: "test-model",
  };
}

async function waitFor<T>(read: () => Promise<T | null>, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for PR governance capacity state");
}

describeEmbeddedPostgres("heartbeat PR governance capacity reservation", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let executionResolvers: Array<(result: ExecutionResult) => void> = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-pr-governance-capacity-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  beforeEach(() => {
    executionResolvers = [];
    mockAdapterExecute.mockReset();
    mockAdapterExecute.mockImplementation(() => new Promise<ExecutionResult>((resolve) => {
      executionResolvers.push(resolve);
    }));
  });

  afterEach(async () => {
    for (const resolve of executionResolvers.splice(0)) resolve(successfulExecutionResult());
    await db.delete(heartbeatRunEvents);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentTaskSessions);
    await db.delete(agentRuntimeState);
    await db.delete(companySkills);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCapacityFixture() {
    const companyId = randomUUID();
    const governanceAgentId = randomUUID();
    const deliveryAgentId = randomUUID();
    const fillerAgentIds = [randomUUID(), randomUUID(), randomUUID()];
    const governanceIssueId = randomUUID();
    const deliveryIssueId = randomUUID();
    const governanceWakeupId = randomUUID();
    const governanceRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Capacity Test Co",
      status: "active",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "capacity-test-user",
      requireBoardApprovalForNewAgents: false,
    });

    const agentValues = [
      {
        id: governanceAgentId,
        companyId,
        name: "PR Manager",
        role: "release_manager",
        status: "idle" as const,
      },
      {
        id: deliveryAgentId,
        companyId,
        name: "Delivery Engineer",
        role: "engineer",
        status: "idle" as const,
      },
      ...fillerAgentIds.map((id, index) => ({
        id,
        companyId,
        name: `Busy Engineer ${index + 1}`,
        role: "engineer",
        status: "running" as const,
      })),
    ].map((agent) => ({
      ...agent,
      adapterType: "codex_local" as const,
      adapterConfig: {},
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } },
      permissions: {},
    }));
    await db.insert(agents).values(agentValues);

    await db.insert(issues).values([
      {
        id: governanceIssueId,
        companyId,
        title: "Review the PR queue",
        status: "in_progress",
        priority: "critical",
        assigneeAgentId: governanceAgentId,
        responsibleUserId: "capacity-test-user",
      },
      {
        id: deliveryIssueId,
        companyId,
        title: "Continue delivery work",
        status: "in_progress",
        priority: "high",
        assigneeAgentId: deliveryAgentId,
        responsibleUserId: "capacity-test-user",
      },
    ]);

    const fillerRunIds = fillerAgentIds.map(() => randomUUID());
    await db.insert(heartbeatRuns).values(fillerAgentIds.map((agentId, index) => ({
      id: fillerRunIds[index],
      companyId,
      agentId,
      invocationSource: "automation" as const,
      triggerDetail: "system" as const,
      status: "running" as const,
      startedAt: new Date(),
    })));
    await db.insert(agentWakeupRequests).values({
      id: governanceWakeupId,
      companyId,
      agentId: governanceAgentId,
      source: "automation",
      triggerDetail: "system",
      reason: "pr_queue_monitor",
      status: "queued",
    });
    await db.insert(heartbeatRuns).values({
      id: governanceRunId,
      companyId,
      agentId: governanceAgentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId: governanceWakeupId,
      contextSnapshot: {
        issueId: governanceIssueId,
        taskId: governanceIssueId,
        wakeReason: "pr_queue_monitor",
      },
    });

    return {
      companyId,
      governanceAgentId,
      deliveryAgentId,
      governanceIssueId,
      deliveryIssueId,
      governanceRunId,
      fillerRunIds,
    };
  }

  async function setGovernanceRunningRun(input: {
    companyId: string;
    governanceAgentId: string;
    governanceRunId: string;
    governanceIssueId: string;
  }) {
    await db
      .update(heartbeatRuns)
      .set({ status: "running", startedAt: new Date(), updatedAt: new Date() })
      .where(eq(heartbeatRuns.id, input.governanceRunId));
    await db
      .update(agents)
      .set({ status: "running", updatedAt: new Date() })
      .where(eq(agents.id, input.governanceAgentId));
    await db
      .update(issues)
      .set({
        executionRunId: input.governanceRunId,
        executionAgentNameKey: "pr-manager",
        executionLockedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(issues.id, input.governanceIssueId));
  }

  async function finishGovernanceRunBeforeDeliveryClaim(input: {
    governanceAgentId: string;
    governanceRunId: string;
    governanceIssueId: string;
  }) {
    await db
      .update(heartbeatRuns)
      .set({ status: "succeeded", finishedAt: new Date(), updatedAt: new Date() })
      .where(eq(heartbeatRuns.id, input.governanceRunId));
    await db
      .update(agents)
      .set({ status: "idle", updatedAt: new Date() })
      .where(eq(agents.id, input.governanceAgentId));
    await db
      .update(issues)
      .set({
        executionRunId: null,
        executionAgentNameKey: null,
        executionLockedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(issues.id, input.governanceIssueId));
  }

  function createHeartbeat(
    governanceAgentId: string,
    beforeGlobalLlmClaim?: NonNullable<Parameters<typeof heartbeatService>[1]>["beforeGlobalLlmClaim"],
  ) {
    return heartbeatService(db, {
      runtimeEnv: {
        PAPERCLIP_PR_GOVERNANCE_AGENT_IDS: governanceAgentId,
        PAPERCLIP_PR_GOVERNANCE_RESERVED_SLOTS: "1",
      },
      beforeGlobalLlmClaim,
    });
  }

  it("holds the fourth slot for runnable governance and globally pumps delivery afterward", async () => {
    const fixture = await seedCapacityFixture();
    const heartbeat = createHeartbeat(fixture.governanceAgentId);

    const deliveryRun = await heartbeat.wakeup(fixture.deliveryAgentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "delivery_queue",
      contextSnapshot: {
        issueId: fixture.deliveryIssueId,
        taskId: fixture.deliveryIssueId,
      },
      requestedByActorType: "system",
      requestedByActorId: "capacity_test",
    });
    expect(deliveryRun).not.toBeNull();
    expect((await heartbeat.getRun(deliveryRun!.id))?.status).toBe("queued");

    await heartbeat.resumeQueuedRuns();
    await waitFor(async () =>
      (await heartbeat.getRun(fixture.governanceRunId))?.status === "running" ? true : null
    );
    await waitFor(async () => mockAdapterExecute.mock.calls.length === 1 ? true : null, 10_000);
    expect((await heartbeat.getRun(deliveryRun!.id))?.status).toBe("queued");
    expect(mockAdapterExecute).toHaveBeenCalledTimes(1);

    await db
      .update(issues)
      .set({ status: "done", completedAt: new Date(), updatedAt: new Date() })
      .where(eq(issues.id, fixture.governanceIssueId));
    executionResolvers.shift()!(successfulExecutionResult());

    await waitFor(async () =>
      (await heartbeat.getRun(deliveryRun!.id))?.status === "running" ? true : null
    );
    await waitFor(async () => mockAdapterExecute.mock.calls.length === 2 ? true : null, 10_000);
    expect(mockAdapterExecute).toHaveBeenCalledTimes(2);

    await db
      .update(issues)
      .set({ status: "done", completedAt: new Date(), updatedAt: new Date() })
      .where(eq(issues.id, fixture.deliveryIssueId));
    executionResolvers.shift()!(successfulExecutionResult());
    await heartbeat.drainActiveRunExecutions();

    const settledDeliveryRun = await heartbeat.getRun(deliveryRun!.id);
    expect(settledDeliveryRun?.status).toBe("succeeded");
    expect(settledDeliveryRun?.startedAt).not.toBeNull();
  });

  it("does not reserve capacity for an unscoped governance run", async () => {
    const fixture = await seedCapacityFixture();
    const heartbeat = createHeartbeat(fixture.governanceAgentId);
    await db
      .update(heartbeatRuns)
      .set({ contextSnapshot: {}, updatedAt: new Date() })
      .where(eq(heartbeatRuns.id, fixture.governanceRunId));

    const deliveryRun = await heartbeat.wakeup(fixture.deliveryAgentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "delivery_queue",
      contextSnapshot: {
        issueId: fixture.deliveryIssueId,
        taskId: fixture.deliveryIssueId,
      },
      requestedByActorType: "system",
      requestedByActorId: "capacity_test",
    });
    expect(deliveryRun).not.toBeNull();
    await waitFor(async () =>
      (await heartbeat.getRun(deliveryRun!.id))?.status === "running" ? true : null
    );
    await waitFor(async () => mockAdapterExecute.mock.calls.length === 1 ? true : null, 10_000);
    expect(mockAdapterExecute).toHaveBeenCalledTimes(1);

    await heartbeat.cancelQueuedRun(fixture.governanceRunId, "Test cleanup");
    await db
      .update(issues)
      .set({ status: "done", completedAt: new Date(), updatedAt: new Date() })
      .where(eq(issues.id, fixture.deliveryIssueId));
    executionResolvers.shift()!(successfulExecutionResult());
    await heartbeat.drainActiveRunExecutions();
  });

  it("re-establishes the reservation when governance finishes between preflight and delivery claim", async () => {
    const fixture = await seedCapacityFixture();
    const queuedGovernanceRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: queuedGovernanceRunId,
      companyId: fixture.companyId,
      agentId: fixture.governanceAgentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "queued",
      contextSnapshot: {
        issueId: fixture.governanceIssueId,
        taskId: fixture.governanceIssueId,
        wakeReason: "pr_queue_monitor_followup",
      },
    });
    await setGovernanceRunningRun(fixture);
    await db
      .update(heartbeatRuns)
      .set({ status: "succeeded", finishedAt: new Date(), updatedAt: new Date() })
      .where(eq(heartbeatRuns.id, fixture.fillerRunIds[2]));

    let releaseClaim!: () => void;
    const claimGate = new Promise<void>((resolve) => { releaseClaim = resolve; });
    let claimReached!: () => void;
    const claimReachedGate = new Promise<void>((resolve) => { claimReached = resolve; });
    const heartbeat = createHeartbeat(fixture.governanceAgentId, async (input) => {
      if (input.agentId !== fixture.deliveryAgentId) return;
      expect(input.runnableGovernanceRunIds).toContain(queuedGovernanceRunId);
      claimReached();
      await claimGate;
    });

    // Governance currently covers the reservation, so delivery may proceed to
    // its final claim preflight. Finish governance while that claim is paused;
    // the global-lock recheck must see the uncovered candidate and deny delivery.
    const deliveryWake = heartbeat.wakeup(fixture.deliveryAgentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "delivery_queue",
      contextSnapshot: {
        issueId: fixture.deliveryIssueId,
        taskId: fixture.deliveryIssueId,
      },
      requestedByActorType: "system",
      requestedByActorId: "capacity_test",
    });
    await Promise.race([
      claimReachedGate,
      new Promise((_, reject) => setTimeout(() => reject(new Error("delivery did not reach claim gate")), 5_000)),
    ]);
    await finishGovernanceRunBeforeDeliveryClaim(fixture);
    await db
      .update(heartbeatRuns)
      .set({ status: "running", finishedAt: null, updatedAt: new Date() })
      .where(eq(heartbeatRuns.id, fixture.fillerRunIds[2]));
    releaseClaim();
    const deliveryRun = await deliveryWake;
    expect(deliveryRun).not.toBeNull();
    expect((await heartbeat.getRun(deliveryRun!.id))?.status).toBe("queued");
    expect(mockAdapterExecute).not.toHaveBeenCalled();
  });

  it.each(["blocked", "backlog"] as const)(
    "does not reserve capacity for %s governance work",
    async (governanceStatus) => {
      const fixture = await seedCapacityFixture();
      const heartbeat = createHeartbeat(fixture.governanceAgentId);
      await db
        .update(issues)
        .set({ status: governanceStatus, updatedAt: new Date() })
        .where(eq(issues.id, fixture.governanceIssueId));

      const deliveryRun = await heartbeat.wakeup(fixture.deliveryAgentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "delivery_queue",
        contextSnapshot: {
          issueId: fixture.deliveryIssueId,
          taskId: fixture.deliveryIssueId,
        },
        requestedByActorType: "system",
        requestedByActorId: "capacity_test",
      });
      expect(deliveryRun).not.toBeNull();
      await waitFor(async () =>
        (await heartbeat.getRun(deliveryRun!.id))?.status === "running" ? true : null
      );
      await waitFor(async () => mockAdapterExecute.mock.calls.length === 1 ? true : null, 10_000);

      await heartbeat.cancelQueuedRun(fixture.governanceRunId, "Test cleanup");
      await db
        .update(issues)
        .set({ status: "done", completedAt: new Date(), updatedAt: new Date() })
        .where(eq(issues.id, fixture.deliveryIssueId));
      executionResolvers.shift()!(successfulExecutionResult());
      await heartbeat.drainActiveRunExecutions();
    },
  );
});
