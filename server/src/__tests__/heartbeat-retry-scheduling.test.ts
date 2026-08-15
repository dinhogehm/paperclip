import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  activityLog,
  budgetPolicies,
  claudeAccounts,
  codexAccounts,
  companies,
  companySkills,
  createDb,
  environmentLeases,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  issueRelations,
  issues,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.ts";
import {
  BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS,
  INTERACTION_CONTINUATION_INFRA_RETRY_REASON,
  INTERACTION_CONTINUATION_INFRA_WAKE_REASON,
  MAX_TURN_CONTINUATION_RETRY_REASON,
  MAX_TURN_CONTINUATION_WAKE_REASON,
  heartbeatService,
} from "../services/heartbeat.ts";
import { resolveCodexAccountHome } from "../services/codex-accounts.ts";
import { resolveClaudeAccountConfigDir } from "../services/claude-accounts.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const PROVIDER_QUOTA_TEST_ADAPTER = "provider_quota_test";

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat retry scheduling tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function waitForRunToFinish(
  heartbeat: ReturnType<typeof heartbeatService>,
  runId: string,
  timeoutMs = 5_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await heartbeat.getRun(runId);
    if (run && !["queued", "running"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return await heartbeat.getRun(runId);
}

describeEmbeddedPostgres("heartbeat bounded retry scheduling", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-retry-scheduling-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    registerServerAdapter({
      type: PROVIDER_QUOTA_TEST_ADAPTER,
      execute: async () => ({
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: "You've hit your session limit - resets at 4pm (America/Chicago).",
        errorCode: "provider_quota",
        errorFamily: "provider_quota",
        retryNotBefore: "2030-04-22T21:00:00.000Z",
        resultJson: {
          errorFamily: "provider_quota",
          retryNotBefore: "2030-04-22T21:00:00.000Z",
          providerQuotaRetryNotBefore: "2030-04-22T21:00:00.000Z",
        },
      }),
      testEnvironment: async () => ({
        adapterType: PROVIDER_QUOTA_TEST_ADAPTER,
        status: "pass",
        checks: [],
        testedAt: new Date().toISOString(),
      }),
    });
  }, 20_000);

  afterEach(async () => {
    // Await every in-flight background heartbeat run to quiescence before the
    // cleanup deletes. heartbeat.invoke claims a run and dispatches its
    // execution fire-and-forget, and that run can schedule a follow-up retry
    // wakeup, so a run or wakeup can still write heartbeat_runs and issues rows
    // when teardown starts. The cleanup deletes issues before heartbeat_runs, so
    // a late write races the deletes and can deadlock or break a foreign key.
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    await cleanupRetryFixture();
  });

  afterAll(async () => {
    unregisterServerAdapter(PROVIDER_QUOTA_TEST_ADAPTER);
    await tempDb?.cleanup();
  });

  async function cleanupRetryFixture() {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await cleanupRetryFixtureOnce();
        return;
      } catch (error) {
        if (attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  }

  async function cleanupHeartbeatRunDependents() {
    await db.delete(heartbeatRunEvents);
    await db.delete(activityLog);
    await new Promise((resolve) => setTimeout(resolve, 25));
    await db.delete(heartbeatRunEvents);
    await db.delete(activityLog);
  }

  async function cleanupRetryFixtureOnce() {
    await db.delete(activityLog);
    await db.delete(environmentLeases);
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projects);
    await cleanupHeartbeatRunDependents();
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(budgetPolicies);
    await db.delete(agents);
    await db.delete(companySkills);
    await db.delete(companies);
  }

  async function seedRetryFixture(input: {
    runId: string;
    companyId: string;
    agentId: string;
    now: Date;
    errorCode: string;
    errorFamily?: "transient_upstream" | "provider_quota" | null;
    retryNotBefore?: string | null;
    scheduledRetryAttempt?: number;
    resultJson?: Record<string, unknown> | null;
    adapterType?: string;
    agentName?: string;
  }) {
    const adapterType = input.adapterType ?? "codex_local";
    const agentName = input.agentName ?? (adapterType === "claude_local" ? "ClaudeCoder" : "CodexCoder");
    await db.insert(companies).values({
      id: input.companyId,
      name: "Paperclip",
      issuePrefix: `T${input.companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });

    await db.insert(agents).values({
      id: input.agentId,
      companyId: input.companyId,
      name: agentName,
      role: "engineer",
      status: "active",
      adapterType,
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: input.runId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "assignment",
      status: "failed",
      error: "upstream overload",
      errorCode: input.errorCode,
      finishedAt: input.now,
      scheduledRetryAttempt: input.scheduledRetryAttempt ?? 0,
      scheduledRetryReason: input.scheduledRetryAttempt ? "transient_failure" : null,
      resultJson: input.resultJson ?? {
        ...(input.errorFamily ? { errorFamily: input.errorFamily } : {}),
        ...(input.retryNotBefore
          ? {
              retryNotBefore: input.retryNotBefore,
              transientRetryNotBefore: input.retryNotBefore,
            }
          : {}),
      },
      contextSnapshot: {
        issueId: randomUUID(),
        wakeReason: "issue_assigned",
      },
      updatedAt: input.now,
      createdAt: input.now,
    });
  }

  it("records provider quota failures, schedules the reset-time retry, and leaves the agent idle", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Quota Test",
      role: "engineer",
      status: "idle",
      adapterType: PROVIDER_QUOTA_TEST_ADAPTER,
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });

    const run = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    expect(run).not.toBeNull();

    const failedRun = await waitForRunToFinish(heartbeat, run!.id);
    expect(failedRun?.status).toBe("failed");
    expect(failedRun?.errorCode).toBe("provider_quota");
    expect((failedRun?.resultJson as Record<string, unknown> | null)?.errorFamily).toBe("provider_quota");

    await expect
      .poll(
        () =>
          db
            .select({ id: heartbeatRuns.id })
            .from(heartbeatRuns)
            .where(eq(heartbeatRuns.retryOfRunId, run!.id))
            .then((rows) => rows.length),
        { timeout: 5_000, interval: 50 },
      )
      .toBe(1);

    const retryRun = await db
      .select({
        id: heartbeatRuns.id,
        status: heartbeatRuns.status,
        scheduledRetryAt: heartbeatRuns.scheduledRetryAt,
        scheduledRetryReason: heartbeatRuns.scheduledRetryReason,
        contextSnapshot: heartbeatRuns.contextSnapshot,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.retryOfRunId, run!.id))
      .then((rows) => rows[0] ?? null);
    expect(retryRun?.status).toBe("scheduled_retry");
    expect(retryRun?.scheduledRetryReason).toBe("transient_failure");
    expect(retryRun?.scheduledRetryAt?.toISOString()).toBe("2030-04-22T21:00:00.000Z");
    expect((retryRun?.contextSnapshot as Record<string, unknown> | null)?.errorFamily).toBe("provider_quota");
    expect((retryRun?.contextSnapshot as Record<string, unknown> | null)?.providerQuotaRetryNotBefore).toBe(
      "2030-04-22T21:00:00.000Z",
    );
    expect((retryRun?.contextSnapshot as Record<string, unknown> | null)?.codexTransientFallbackMode ?? null).toBeNull();

    await expect
      .poll(
        () =>
          db
            .select({ status: agents.status, errorReason: agents.errorReason })
            .from(agents)
            .where(eq(agents.id, agentId))
            .then((rows) => rows[0] ?? null),
        { timeout: 5_000, interval: 50 },
      )
      .toEqual({ status: "idle", errorReason: null });
  });

  it.each([
    ["first-available", "first_available"],
    ["fixed", "fixed"],
  ] as const)("defers %s work when the selected authenticated account is at session capacity", async (
    _label,
    accountMode,
  ) => {
    const companyId = randomUUID();
    const targetAgentId = randomUUID();
    const busyAgentId = randomUUID();
    const codexAccountId = randomUUID();
    const busyRunIds = [randomUUID(), randomUUID()];
    const previousPaperclipHome = process.env.PAPERCLIP_HOME;
    const paperclipHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-account-capacity-"));
    process.env.PAPERCLIP_HOME = paperclipHome;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      rate_limit: {
        primary_window: {
          used_percent: 20,
          limit_window_seconds: 18_000,
          reset_at: null,
        },
      },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })));

    try {
      await db.insert(companies).values({
        id: companyId,
        name: "Managed account capacity",
        issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
        defaultResponsibleUserId: "responsible-user",
      });
      await db.insert(codexAccounts).values({
        id: codexAccountId,
        companyId,
        name: "Only authenticated account",
      });
      const codexHome = resolveCodexAccountHome(companyId, codexAccountId);
      await fs.mkdir(codexHome, { recursive: true });
      await fs.writeFile(path.join(codexHome, "auth.json"), JSON.stringify({
        tokens: { access_token: "test-access-token", account_id: "test-account" },
      }));
      await db.insert(agents).values([
        {
          id: targetAgentId,
          companyId,
          name: "Waiting worker",
          role: "engineer",
          status: "idle",
          adapterType: "codex_local",
          codexAccountMode: accountMode,
          ...(accountMode === "fixed" ? { codexAccountId } : {}),
          adapterConfig: {},
          runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
          permissions: {},
        },
        {
          id: busyAgentId,
          companyId,
          name: "Capacity holder",
          role: "engineer",
          status: "active",
          adapterType: "codex_local",
          adapterConfig: {},
          runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 2 } },
          permissions: {},
        },
      ]);
      await db.insert(heartbeatRuns).values(busyRunIds.map((id) => ({
        id,
        companyId,
        agentId: busyAgentId,
        status: "running",
        startedAt: new Date(),
        contextSnapshot: {
          paperclipEffectiveAdapterType: "codex_local",
          paperclipCodexAccount: {
            mode: accountMode,
            accountId: codexAccountId,
          },
        },
      })));

      const run = await heartbeat.invoke(targetAgentId, "on_demand", {}, "manual");
      expect(run).not.toBeNull();
      const deferredRun = await waitForRunToFinish(heartbeat, run!.id);

      expect(deferredRun).toMatchObject({
        status: "cancelled",
        errorCode: "subscription_account_capacity",
      });
      expect(deferredRun?.errorCode).not.toBe("configuration_incomplete");
      expect(deferredRun?.resultJson).toMatchObject({
        subscriptionAccountCapacity: {
          providers: ["codex_local"],
          deferralAttempt: 0,
        },
      });

      await expect.poll(
        () => db
          .select()
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.retryOfRunId, run!.id))
          .then((rows) => rows[0] ?? null),
        { timeout: 5_000, interval: 50 },
      ).toMatchObject({
        status: "scheduled_retry",
        scheduledRetryAttempt: 1,
        scheduledRetryReason: "subscription_account_capacity",
      });
    } finally {
      await db.update(heartbeatRuns)
        .set({ status: "cancelled", finishedAt: new Date() })
        .where(inArray(heartbeatRuns.id, busyRunIds));
      vi.unstubAllGlobals();
      if (previousPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
      else process.env.PAPERCLIP_HOME = previousPaperclipHome;
      await fs.rm(paperclipHome, { recursive: true, force: true });
    }
  });

  it("re-evaluates both providers after a capacity deferral instead of retaining a forced pin", async () => {
    const companyId = randomUUID();
    const targetAgentId = randomUUID();
    const busyAgentId = randomUUID();
    const codexAccountId = randomUUID();
    const busyRunIds = [randomUUID(), randomUUID()];
    const quotaDeadline = "2030-04-22T21:00:00.000Z";
    const previousPaperclipHome = process.env.PAPERCLIP_HOME;
    const paperclipHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-capacity-failover-"));
    process.env.PAPERCLIP_HOME = paperclipHome;
    const codexExecute = vi.fn(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      summary: "Codex should not execute while its managed account is full",
    }));
    const claudeExecute = vi.fn(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      summary: "Claude completed after provider re-evaluation",
    }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      rate_limit: {
        primary_window: {
          used_percent: 20,
          limit_window_seconds: 18_000,
          reset_at: null,
        },
      },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })));
    registerServerAdapter({
      type: "codex_local",
      execute: codexExecute,
      testEnvironment: async () => ({
        adapterType: "codex_local",
        status: "pass",
        checks: [],
        testedAt: new Date().toISOString(),
      }),
    });
    registerServerAdapter({
      type: "claude_local",
      execute: claudeExecute,
      testEnvironment: async () => ({
        adapterType: "claude_local",
        status: "pass",
        checks: [],
        testedAt: new Date().toISOString(),
      }),
    });

    try {
      await db.insert(companies).values({
        id: companyId,
        name: "Capacity failover",
        issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
        defaultResponsibleUserId: "responsible-user",
      });
      await db.insert(codexAccounts).values({
        id: codexAccountId,
        companyId,
        name: "Busy Codex account",
      });
      const codexHome = resolveCodexAccountHome(companyId, codexAccountId);
      await fs.mkdir(codexHome, { recursive: true });
      await fs.writeFile(path.join(codexHome, "auth.json"), JSON.stringify({
        tokens: { access_token: "test-access-token", account_id: "test-account" },
      }));
      await db.insert(agents).values([
        {
          id: targetAgentId,
          companyId,
          name: "Failover worker",
          role: "engineer",
          status: "idle",
          adapterType: "codex_local",
          codexAccountMode: "first_available",
          claudeAccountMode: "host",
          adapterConfig: {},
          runtimeConfig: {
            heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 },
            subscriptionFailover: {
              enabled: true,
              order: ["codex_local", "claude_local"],
            },
          },
          permissions: {},
        },
        {
          id: busyAgentId,
          companyId,
          name: "Capacity holder",
          role: "engineer",
          status: "active",
          adapterType: "codex_local",
          adapterConfig: {},
          runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 2 } },
          permissions: {},
        },
      ]);
      await db.insert(heartbeatRuns).values(busyRunIds.map((id) => ({
        id,
        companyId,
        agentId: busyAgentId,
        status: "running",
        startedAt: new Date(),
        contextSnapshot: {
          paperclipEffectiveAdapterType: "codex_local",
          paperclipCodexAccount: {
            mode: "first_available",
            accountId: codexAccountId,
          },
        },
      })));

      const run = await heartbeat.invoke(targetAgentId, "on_demand", {
        paperclipEffectiveAdapterType: "codex_local",
        paperclipSubscriptionFailover: {
          effectiveAdapterType: "codex_local",
          quotaNotBeforeByProvider: { codex_local: quotaDeadline },
        },
        forceFreshSession: true,
      }, "manual");
      expect(run).not.toBeNull();
      expect(await waitForRunToFinish(heartbeat, run!.id)).toMatchObject({
        status: "cancelled",
        errorCode: "subscription_account_capacity",
      });

      await expect.poll(
        () => db
          .select()
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.retryOfRunId, run!.id))
          .then((rows) => rows[0] ?? null),
        { timeout: 5_000, interval: 50 },
      ).not.toBeNull();
      const retryRun = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.retryOfRunId, run!.id))
        .then((rows) => rows[0]!);
      const retryContext = retryRun.contextSnapshot as Record<string, unknown>;
      expect(retryContext.paperclipEffectiveAdapterType).toBeUndefined();
      expect(retryContext.paperclipCodexAccount).toBeUndefined();
      expect(retryContext.forceFreshSession).toBe(true);
      expect(retryContext.paperclipSubscriptionFailover).toMatchObject({
        quotaNotBeforeByProvider: { codex_local: quotaDeadline },
      });
      expect((retryContext.paperclipSubscriptionFailover as Record<string, unknown>).effectiveAdapterType)
        .toBeUndefined();

      expect(await heartbeat.promoteDueScheduledRetries(retryRun.scheduledRetryAt!))
        .toEqual({ promoted: 1, runIds: [retryRun.id] });
      await heartbeat.resumeQueuedRuns();
      expect(await waitForRunToFinish(heartbeat, retryRun.id)).toMatchObject({ status: "succeeded" });
      expect(codexExecute).not.toHaveBeenCalled();
      expect(claudeExecute).toHaveBeenCalledTimes(1);
    } finally {
      await db.update(heartbeatRuns)
        .set({ status: "cancelled", finishedAt: new Date() })
        .where(inArray(heartbeatRuns.id, busyRunIds));
      unregisterServerAdapter("codex_local");
      unregisterServerAdapter("claude_local");
      vi.unstubAllGlobals();
      if (previousPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
      else process.env.PAPERCLIP_HOME = previousPaperclipHome;
      await fs.rm(paperclipHome, { recursive: true, force: true });
    }
  });

  it("fails a fixed unauthenticated account without substituting another company account", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const fixedAccountId = randomUUID();
    const otherAccountId = randomUUID();
    const previousPaperclipHome = process.env.PAPERCLIP_HOME;
    const paperclipHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-fixed-account-auth-"));
    process.env.PAPERCLIP_HOME = paperclipHome;
    const quotaFetch = vi.fn(async () => new Response(JSON.stringify({
      rate_limit: {
        primary_window: {
          used_percent: 20,
          limit_window_seconds: 18_000,
          reset_at: null,
        },
      },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", quotaFetch);

    try {
      await db.insert(companies).values({
        id: companyId,
        name: "Fixed account authentication",
        issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
        defaultResponsibleUserId: "responsible-user",
      });
      await db.insert(codexAccounts).values([
        {
          id: fixedAccountId,
          companyId,
          name: "Fixed but signed out",
        },
        {
          id: otherAccountId,
          companyId,
          name: "Authenticated but not selected",
        },
      ]);
      const otherCodexHome = resolveCodexAccountHome(companyId, otherAccountId);
      await fs.mkdir(otherCodexHome, { recursive: true });
      await fs.writeFile(path.join(otherCodexHome, "auth.json"), JSON.stringify({
        tokens: { access_token: "other-access-token", account_id: "other-account" },
      }));
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "Fixed worker",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        codexAccountMode: "fixed",
        codexAccountId: fixedAccountId,
        adapterConfig: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
        permissions: {},
      });

      const run = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
      expect(run).not.toBeNull();
      const failedRun = await waitForRunToFinish(heartbeat, run!.id);

      expect(failedRun).toMatchObject({
        status: "failed",
        errorCode: "configuration_incomplete",
        resultJson: {
          configurationIncomplete: {
            reason: "codex_account_unavailable",
            companyId,
            agentId,
            adapterType: "codex_local",
          },
        },
      });
      expect(failedRun?.errorCode).not.toBe("subscription_account_capacity");
      // The authenticated account was intentionally not the configured fixed
      // account, so it must not even be quota-probed as a fallback candidate.
      expect(quotaFetch).not.toHaveBeenCalled();
      await expect(db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.retryOfRunId, run!.id)))
        .resolves.toHaveLength(0);
    } finally {
      vi.unstubAllGlobals();
      if (previousPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
      else process.env.PAPERCLIP_HOME = previousPaperclipHome;
      await fs.rm(paperclipHome, { recursive: true, force: true });
    }
  });

  it("switches a quota retry to the secondary provider without waiting for the primary reset", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const claudeAccountId = randomUUID();
    const primaryResetAt = "2030-04-22T21:00:00.000Z";
    const claudeConfigs: Record<string, unknown>[] = [];
    const previousPaperclipHome = process.env.PAPERCLIP_HOME;
    const previousClaudeExecutable = process.env.PAPERCLIP_CLAUDE_EXECUTABLE;
    const previousAmbientOpenAiKey = process.env.OPENAI_API_KEY;
    const previousAmbientCodexHome = process.env.CODEX_HOME;
    const paperclipHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-failover-"));
    const fakeClaudeExecutable = path.join(paperclipHome, "fake-claude");
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_CLAUDE_EXECUTABLE = fakeClaudeExecutable;
    process.env.OPENAI_API_KEY = "ambient-openai-must-not-cross";
    process.env.CODEX_HOME = "/ambient/codex-must-not-cross";
    await fs.writeFile(
      fakeClaudeExecutable,
      '#!/bin/sh\nprintf \'%s\\n\' \'{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max"}\'\n',
    );
    await fs.chmod(fakeClaudeExecutable, 0o755);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      five_hour: { utilization: 20, resets_at: null },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })));

    registerServerAdapter({
      type: "codex_local",
      execute: async () => ({
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: "Codex weekly quota exhausted",
        errorCode: "provider_quota",
        errorFamily: "provider_quota",
        retryNotBefore: primaryResetAt,
        resultJson: {
          errorFamily: "provider_quota",
          retryNotBefore: primaryResetAt,
          providerQuotaRetryNotBefore: primaryResetAt,
        },
      }),
      testEnvironment: async () => ({
        adapterType: "codex_local",
        status: "pass",
        checks: [],
        testedAt: new Date().toISOString(),
      }),
    });
    registerServerAdapter({
      type: "claude_local",
      execute: async ({ config }) => {
        claudeConfigs.push(config);
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          summary: "Claude fallback completed",
          provider: "anthropic",
          model: "claude-test",
        };
      },
      testEnvironment: async () => ({
        adapterType: "claude_local",
        status: "pass",
        checks: [],
        testedAt: new Date().toISOString(),
      }),
    });

    try {
      await db.insert(companies).values({
        id: companyId,
        name: "Paperclip",
        issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
        defaultResponsibleUserId: "responsible-user",
      });
      await db.insert(claudeAccounts).values({
        id: claudeAccountId,
        companyId,
        name: "Fallback Claude",
      });
      const claudeConfigDir = resolveClaudeAccountConfigDir(companyId, claudeAccountId);
      await fs.mkdir(claudeConfigDir, { recursive: true });
      await fs.writeFile(path.join(claudeConfigDir, ".credentials.json"), JSON.stringify({
        claudeAiOauth: { accessToken: "test-claude-token" },
      }));
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "Dual Provider",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        claudeAccountMode: "fixed",
        claudeAccountId,
        adapterConfig: {
          command: "custom-codex",
          model: "gpt-primary",
          extraArgs: ["--codex-only"],
          env: {
            OPENAI_API_KEY: "test-only",
            ANTHROPIC_API_KEY: "must-not-win",
          },
        },
        runtimeConfig: {
          heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 },
          subscriptionFailover: {
            enabled: true,
            order: ["codex_local", "claude_local"],
          },
        },
        permissions: {},
      });

      const run = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
      expect(run).not.toBeNull();
      const failedRun = await waitForRunToFinish(heartbeat, run!.id);
      expect(failedRun?.errorCode).toBe("provider_quota");

      await expect.poll(
        () => db
          .select()
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.retryOfRunId, run!.id))
          .then((rows) => rows[0] ?? null),
        { timeout: 5_000, interval: 50 },
      ).not.toBeNull();

      const retryRun = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.retryOfRunId, run!.id))
        .then((rows) => rows[0]!);
      const retryContext = retryRun.contextSnapshot as Record<string, unknown>;
      expect(retryRun.scheduledRetryAt!.getTime()).toBeLessThan(new Date(primaryResetAt).getTime());
      expect(retryContext.paperclipEffectiveAdapterType).toBe("claude_local");
      expect(retryContext.forceFreshSession).toBe(true);
      expect(retryContext.paperclipSubscriptionFailover).toMatchObject({
        effectiveAdapterType: "claude_local",
        quotaNotBeforeByProvider: { codex_local: primaryResetAt },
      });

      const promotion = await heartbeat.promoteDueScheduledRetries(retryRun.scheduledRetryAt!);
      expect(promotion).toEqual({ promoted: 1, runIds: [retryRun.id] });
      await heartbeat.resumeQueuedRuns();
      const completedRetry = await waitForRunToFinish(heartbeat, retryRun.id);
      expect(completedRetry?.status).toBe("succeeded");
      expect(claudeConfigs).toHaveLength(1);
      expect(claudeConfigs[0]).not.toHaveProperty("command");
      expect(claudeConfigs[0]).not.toHaveProperty("extraArgs");
      expect(claudeConfigs[0]).not.toHaveProperty("model", "gpt-primary");
      expect(claudeConfigs[0]?.env).toMatchObject({
        ANTHROPIC_API_KEY: "",
        ANTHROPIC_AUTH_TOKEN: "",
        CLAUDE_CODE_OAUTH_TOKEN: "",
      });
      expect((claudeConfigs[0]?.env as Record<string, unknown>).CLAUDE_CONFIG_DIR).toEqual(expect.any(String));
      expect((claudeConfigs[0]?.env as Record<string, unknown>).OPENAI_API_KEY).toBe("");
      expect((claudeConfigs[0]?.env as Record<string, unknown>).CODEX_HOME).toBe("");
    } finally {
      unregisterServerAdapter("codex_local");
      unregisterServerAdapter("claude_local");
      vi.unstubAllGlobals();
      if (previousPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
      else process.env.PAPERCLIP_HOME = previousPaperclipHome;
      if (previousClaudeExecutable === undefined) delete process.env.PAPERCLIP_CLAUDE_EXECUTABLE;
      else process.env.PAPERCLIP_CLAUDE_EXECUTABLE = previousClaudeExecutable;
      if (previousAmbientOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousAmbientOpenAiKey;
      if (previousAmbientCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousAmbientCodexHome;
      await fs.rm(paperclipHome, { recursive: true, force: true });
    }
  });

  it("executes Claude to Codex failover with managed Codex auth pinned", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const codexAccountId = randomUUID();
    const primaryResetAt = "2030-04-22T21:00:00.000Z";
    const codexConfigs: Record<string, unknown>[] = [];
    const previousPaperclipHome = process.env.PAPERCLIP_HOME;
    const previousAmbientAnthropicKey = process.env.ANTHROPIC_API_KEY;
    const previousAmbientClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    const paperclipHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-dual-provider-"));
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.ANTHROPIC_API_KEY = "ambient-anthropic-must-not-cross";
    process.env.CLAUDE_CONFIG_DIR = "/ambient/claude-must-not-cross";

    registerServerAdapter({
      type: "claude_local",
      execute: async () => ({
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: "Claude weekly quota exhausted",
        errorCode: "provider_quota",
        errorFamily: "provider_quota",
        retryNotBefore: primaryResetAt,
        resultJson: { errorFamily: "provider_quota", retryNotBefore: primaryResetAt },
      }),
      testEnvironment: async () => ({
        adapterType: "claude_local",
        status: "pass",
        checks: [],
        testedAt: new Date().toISOString(),
      }),
    });
    registerServerAdapter({
      type: "codex_local",
      execute: async ({ config }) => {
        codexConfigs.push(config);
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          summary: "Codex fallback completed",
          provider: "openai",
          model: "codex-test",
        };
      },
      testEnvironment: async () => ({
        adapterType: "codex_local",
        status: "pass",
        checks: [],
        testedAt: new Date().toISOString(),
      }),
    });

    try {
      await db.insert(companies).values({
        id: companyId,
        name: "Paperclip",
        issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
        defaultResponsibleUserId: "responsible-user",
      });
      await db.insert(codexAccounts).values({
        id: codexAccountId,
        companyId,
        name: "Fallback Codex",
      });
      const codexHome = resolveCodexAccountHome(companyId, codexAccountId);
      await fs.mkdir(codexHome, { recursive: true });
      await fs.writeFile(path.join(codexHome, "auth.json"), JSON.stringify({
        tokens: { access_token: "test-access-token", account_id: "test-account" },
      }));
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "Reverse Dual Provider",
        role: "engineer",
        status: "idle",
        adapterType: "claude_local",
        codexAccountMode: "fixed",
        codexAccountId,
        adapterConfig: {
          command: "custom-claude",
          model: "claude-primary",
          extraArgs: ["--claude-only"],
          env: {
            ANTHROPIC_API_KEY: "test-only",
            OPENAI_API_KEY: "must-not-win",
          },
        },
        runtimeConfig: {
          heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 },
          subscriptionFailover: {
            enabled: true,
            order: ["claude_local", "codex_local"],
          },
        },
        permissions: {},
      });

      const run = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
      expect(run).not.toBeNull();
      expect((await waitForRunToFinish(heartbeat, run!.id))?.errorCode).toBe("provider_quota");

      await expect.poll(
        () => db
          .select()
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.retryOfRunId, run!.id))
          .then((rows) => rows[0] ?? null),
        { timeout: 5_000, interval: 50 },
      ).not.toBeNull();
      const retryRun = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.retryOfRunId, run!.id))
        .then((rows) => rows[0]!);
      expect((retryRun.contextSnapshot as Record<string, unknown>).paperclipEffectiveAdapterType)
        .toBe("codex_local");

      expect(await heartbeat.promoteDueScheduledRetries(retryRun.scheduledRetryAt!))
        .toEqual({ promoted: 1, runIds: [retryRun.id] });
      await heartbeat.resumeQueuedRuns();
      expect((await waitForRunToFinish(heartbeat, retryRun.id))?.status).toBe("succeeded");
      expect(codexConfigs).toHaveLength(1);
      expect(codexConfigs[0]).not.toHaveProperty("command");
      expect(codexConfigs[0]).not.toHaveProperty("extraArgs");
      expect(codexConfigs[0]).not.toHaveProperty("model", "claude-primary");
      expect(codexConfigs[0]?.env).toMatchObject({
        OPENAI_API_KEY: "",
        OPENAI_BASE_URL: "",
      });
      expect((codexConfigs[0]?.env as Record<string, unknown>).CODEX_HOME).toEqual(expect.any(String));
      expect((codexConfigs[0]?.env as Record<string, unknown>).ANTHROPIC_API_KEY).toBe("");
      expect((codexConfigs[0]?.env as Record<string, unknown>).CLAUDE_CONFIG_DIR).toBe("");
    } finally {
      unregisterServerAdapter("claude_local");
      unregisterServerAdapter("codex_local");
      if (previousPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
      else process.env.PAPERCLIP_HOME = previousPaperclipHome;
      if (previousAmbientAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previousAmbientAnthropicKey;
      if (previousAmbientClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previousAmbientClaudeConfigDir;
      await fs.rm(paperclipHome, { recursive: true, force: true });
    }
  });

  async function seedMaxTurnFixture(input?: {
    companyId?: string;
    agentId?: string;
    issueId?: string;
    runId?: string;
    now?: Date;
    scheduledRetryAttempt?: number;
    runtimeConfig?: Record<string, unknown>;
    issueStatus?: string;
  }) {
    const companyId = input?.companyId ?? randomUUID();
    const agentId = input?.agentId ?? randomUUID();
    const issueId = input?.issueId ?? randomUUID();
    const runId = input?.runId ?? randomUUID();
    const now = input?.now ?? new Date("2026-04-20T12:00:00.000Z");
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "ClaudeCoder",
      role: "engineer",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: input?.runtimeConfig ?? {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
          maxTurnContinuation: {
            enabled: true,
            maxAttempts: 2,
            delayMs: 1_000,
          },
        },
      },
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "failed",
      error: "Maximum turns reached",
      errorCode: "adapter_failed",
      finishedAt: now,
      scheduledRetryAttempt: input?.scheduledRetryAttempt ?? 0,
      scheduledRetryReason: input?.scheduledRetryAttempt ? MAX_TURN_CONTINUATION_RETRY_REASON : null,
      resultJson: {
        stopReason: "max_turns_exhausted",
      },
      contextSnapshot: {
        issueId,
        wakeReason: "issue_assigned",
      },
      updatedAt: now,
      createdAt: now,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Continue after max turns",
      status: input?.issueStatus ?? "in_progress",
      priority: "medium",
      responsibleUserId: "responsible-user",
      assigneeAgentId: agentId,
      executionRunId: runId,
      executionAgentNameKey: "claudecoder",
      executionLockedAt: now,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    return { companyId, agentId, issueId, runId, now };
  }

  it("schedules a retry with durable metadata and only promotes it when due", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const sourceRunId = randomUUID();
    const now = new Date("2026-04-20T12:00:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: sourceRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "failed",
      error: "upstream overload",
      errorCode: "adapter_failed",
      finishedAt: now,
      contextSnapshot: {
        issueId: randomUUID(),
        wakeReason: "issue_assigned",
      },
      updatedAt: now,
      createdAt: now,
    });

    const scheduled = await heartbeat.scheduleBoundedRetry(sourceRunId, {
      now,
      random: () => 0.5,
    });

    expect(scheduled.outcome).toBe("scheduled");
    if (scheduled.outcome !== "scheduled") return;

    const expectedDueAt = new Date(now.getTime() + BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS[0]);
    expect(scheduled.attempt).toBe(1);
    expect(scheduled.dueAt.toISOString()).toBe(expectedDueAt.toISOString());

    const retryRun = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, scheduled.run.id))
      .then((rows) => rows[0] ?? null);

    expect(retryRun).toMatchObject({
      status: "scheduled_retry",
      retryOfRunId: sourceRunId,
      scheduledRetryAttempt: 1,
      scheduledRetryReason: "transient_failure",
    });
    expect(retryRun?.contextSnapshot as Record<string, unknown>).not.toHaveProperty("modelProfile");
    expect(retryRun?.scheduledRetryAt?.toISOString()).toBe(expectedDueAt.toISOString());

    const earlyPromotion = await heartbeat.promoteDueScheduledRetries(new Date("2026-04-20T12:01:59.000Z"));
    expect(earlyPromotion).toEqual({ promoted: 0, runIds: [] });

    const stillScheduled = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, scheduled.run.id))
      .then((rows) => rows[0] ?? null);
    expect(stillScheduled?.status).toBe("scheduled_retry");

    const duePromotion = await heartbeat.promoteDueScheduledRetries(expectedDueAt);
    expect(duePromotion).toEqual({ promoted: 1, runIds: [scheduled.run.id] });

    const promotedRun = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, scheduled.run.id))
      .then((rows) => rows[0] ?? null);
    expect(promotedRun?.status).toBe("queued");
  });

  it("schedules max-turn continuations with distinct retry metadata", async () => {
    const { runId, now } = await seedMaxTurnFixture();

    const scheduled = await heartbeat.scheduleBoundedRetry(runId, {
      now,
      retryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
      wakeReason: MAX_TURN_CONTINUATION_WAKE_REASON,
      maxAttempts: 2,
      delayMs: 1_000,
    });

    expect(scheduled.outcome).toBe("scheduled");
    if (scheduled.outcome !== "scheduled") return;
    expect(scheduled.attempt).toBe(1);
    expect(scheduled.dueAt.toISOString()).toBe(new Date(now.getTime() + 1_000).toISOString());

    const retryRun = await db
      .select({
        retryOfRunId: heartbeatRuns.retryOfRunId,
        status: heartbeatRuns.status,
        scheduledRetryAttempt: heartbeatRuns.scheduledRetryAttempt,
        scheduledRetryReason: heartbeatRuns.scheduledRetryReason,
        contextSnapshot: heartbeatRuns.contextSnapshot,
        wakeupRequestId: heartbeatRuns.wakeupRequestId,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, scheduled.run.id))
      .then((rows) => rows[0] ?? null);

    expect(retryRun).toMatchObject({
      retryOfRunId: runId,
      status: "scheduled_retry",
      scheduledRetryAttempt: 1,
      scheduledRetryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
    });
    expect((retryRun?.contextSnapshot as Record<string, unknown> | null)?.wakeReason).toBe(
      MAX_TURN_CONTINUATION_WAKE_REASON,
    );
    expect((retryRun?.contextSnapshot as Record<string, unknown> | null)?.codexTransientFallbackMode ?? null).toBeNull();

    const wakeupRequest = await db
      .select({ reason: agentWakeupRequests.reason, payload: agentWakeupRequests.payload })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, retryRun?.wakeupRequestId ?? ""))
      .then((rows) => rows[0] ?? null);
    expect(wakeupRequest?.reason).toBe(MAX_TURN_CONTINUATION_WAKE_REASON);
    expect(wakeupRequest?.payload).toMatchObject({
      retryOfRunId: runId,
      retryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
      scheduledRetryAttempt: 1,
    });
  });

  it("schedules accepted interaction continuation infra retries while the issue is in_review", async () => {
    const { issueId, runId, now } = await seedMaxTurnFixture({ issueStatus: "in_review" });
    const interactionId = randomUUID();

    await db
      .update(heartbeatRuns)
      .set({
        error: "workspace validation failed before dispatch",
        errorCode: "workspace_validation_failed",
        resultJson: {},
        contextSnapshot: {
          issueId,
          taskId: issueId,
          wakeReason: "issue_commented",
          mutation: "interaction",
          interactionId,
          interactionKind: "request_confirmation",
          interactionStatus: "accepted",
        },
      })
      .where(eq(heartbeatRuns.id, runId));

    const scheduled = await heartbeat.scheduleBoundedRetry(runId, {
      now,
      random: () => 0.5,
      retryReason: INTERACTION_CONTINUATION_INFRA_RETRY_REASON,
      wakeReason: INTERACTION_CONTINUATION_INFRA_WAKE_REASON,
      maxAttempts: 3,
    });

    expect(scheduled.outcome).toBe("scheduled");
    if (scheduled.outcome !== "scheduled") return;
    expect(scheduled.attempt).toBe(1);
    expect(scheduled.maxAttempts).toBe(3);

    const retryRun = await db
      .select({
        retryOfRunId: heartbeatRuns.retryOfRunId,
        status: heartbeatRuns.status,
        scheduledRetryAttempt: heartbeatRuns.scheduledRetryAttempt,
        scheduledRetryReason: heartbeatRuns.scheduledRetryReason,
        contextSnapshot: heartbeatRuns.contextSnapshot,
        wakeupRequestId: heartbeatRuns.wakeupRequestId,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, scheduled.run.id))
      .then((rows) => rows[0] ?? null);

    expect(retryRun).toMatchObject({
      retryOfRunId: runId,
      status: "scheduled_retry",
      scheduledRetryAttempt: 1,
      scheduledRetryReason: INTERACTION_CONTINUATION_INFRA_RETRY_REASON,
    });
    expect(retryRun?.contextSnapshot).toMatchObject({
      issueId,
      interactionId,
      interactionStatus: "accepted",
      retryReason: INTERACTION_CONTINUATION_INFRA_RETRY_REASON,
      wakeReason: INTERACTION_CONTINUATION_INFRA_WAKE_REASON,
      scheduledRetryAttempt: 1,
    });

    const wakeupRequest = await db
      .select({ reason: agentWakeupRequests.reason, payload: agentWakeupRequests.payload })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, retryRun?.wakeupRequestId ?? ""))
      .then((rows) => rows[0] ?? null);
    expect(wakeupRequest?.reason).toBe(INTERACTION_CONTINUATION_INFRA_WAKE_REASON);
    expect(wakeupRequest?.payload).toMatchObject({
      issueId,
      interactionId,
      retryOfRunId: runId,
      retryReason: INTERACTION_CONTINUATION_INFRA_RETRY_REASON,
      scheduledRetryAttempt: 1,
    });

    const issue = await db
      .select({ executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.executionRunId).toBe(scheduled.run.id);
  });

  it("coalesces duplicate accepted interaction continuation infra retry schedules", async () => {
    const { issueId, runId, now } = await seedMaxTurnFixture({ issueStatus: "in_review" });
    const interactionId = randomUUID();
    await db
      .update(heartbeatRuns)
      .set({
        error: "workspace validation failed before dispatch",
        errorCode: "workspace_validation_failed",
        resultJson: {},
        contextSnapshot: {
          issueId,
          taskId: issueId,
          wakeReason: "issue_commented",
          mutation: "interaction",
          interactionId,
          interactionKind: "request_confirmation",
          interactionStatus: "accepted",
        },
      })
      .where(eq(heartbeatRuns.id, runId));

    const retryOptions = {
      now,
      retryReason: INTERACTION_CONTINUATION_INFRA_RETRY_REASON,
      wakeReason: INTERACTION_CONTINUATION_INFRA_WAKE_REASON,
      maxAttempts: 3,
    };
    const [first, second] = await Promise.all([
      heartbeat.scheduleBoundedRetry(runId, retryOptions),
      heartbeat.scheduleBoundedRetry(runId, retryOptions),
    ]);

    expect(first.outcome).toBe("scheduled");
    expect(second.outcome).toBe("scheduled");
    if (first.outcome !== "scheduled" || second.outcome !== "scheduled") return;
    expect(new Set([first.run.id, second.run.id]).size).toBe(1);

    const retryRuns = await db
      .select({ id: heartbeatRuns.id, wakeupRequestId: heartbeatRuns.wakeupRequestId })
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.retryOfRunId, runId),
        eq(heartbeatRuns.scheduledRetryReason, INTERACTION_CONTINUATION_INFRA_RETRY_REASON),
        eq(heartbeatRuns.scheduledRetryAttempt, 1),
      ));
    expect(retryRuns).toHaveLength(1);

    const wakeups = await db
      .select({
        id: agentWakeupRequests.id,
        coalescedCount: agentWakeupRequests.coalescedCount,
        idempotencyKey: agentWakeupRequests.idempotencyKey,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.reason, INTERACTION_CONTINUATION_INFRA_WAKE_REASON));
    expect(wakeups).toHaveLength(1);
    expect(wakeups[0]).toMatchObject({
      id: retryRuns[0]?.wakeupRequestId,
      coalescedCount: 1,
    });
    expect(wakeups[0]?.idempotencyKey).toContain(`:${issueId}:${runId}:1`);
  });

  it.each([
    {
      name: "renamed branch",
      workspaceValidation: (workspaceId: string) => ({
        reason: "git_worktree_branch_incoherence",
        fingerprint: "workspace_incoherence:v1:sha256:renamed",
        executionWorkspaceId: workspaceId,
        expectedBranch: "stale-plan-approval-workspace",
        actualBranch: "feat/skill-studio-test-runs",
        cleanliness: "clean",
      }),
    },
    {
      name: "dirty worktree",
      workspaceValidation: (workspaceId: string) => ({
        reason: "git_worktree_branch_incoherence",
        fingerprint: "workspace_incoherence:v1:sha256:dirty",
        executionWorkspaceId: workspaceId,
        expectedBranch: "stale-plan-approval-workspace",
        actualBranch: "feat/skill-studio-test-runs",
        cleanliness: "dirty",
        safeRepair: {
          eligible: false,
          attempted: false,
          succeeded: false,
          reason: "worktree is not clean",
        },
      }),
    },
  ])("quarantines a failed $name workspace before scheduling the accepted interaction retry", async ({ workspaceValidation }) => {
    const { companyId, agentId, issueId, runId, now } = await seedMaxTurnFixture({ issueStatus: "in_review" });
    const projectId = randomUUID();
    const executionWorkspaceId = randomUUID();
    const validation = workspaceValidation(executionWorkspaceId);

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Paperclip App",
      status: "in_progress",
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      sourceIssueId: issueId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "stale-plan-approval-workspace",
      status: "active",
      cwd: "/workspace/stale-plan-approval-workspace",
      baseRef: "origin/master",
      branchName: "stale-plan-approval-workspace",
      providerType: "git_worktree",
      providerRef: "/workspace/stale-plan-approval-workspace",
      metadata: { existing: true },
    });
    await db
      .update(issues)
      .set({
        projectId,
        executionWorkspaceId,
        executionWorkspacePreference: "reuse_existing",
        executionWorkspaceSettings: { mode: "isolated_workspace" },
      })
      .where(eq(issues.id, issueId));

    const interactionId = randomUUID();
    await db
      .update(heartbeatRuns)
      .set({
        error: "workspace validation failed before dispatch",
        errorCode: "workspace_validation_failed",
        resultJson: { workspaceValidation: validation },
        contextSnapshot: {
          issueId,
          taskId: issueId,
          wakeReason: "issue_commented",
          mutation: "interaction",
          interactionId,
          interactionKind: "request_confirmation",
          interactionStatus: "accepted",
        },
      })
      .where(eq(heartbeatRuns.id, runId));

    const scheduled = await heartbeat.scheduleBoundedRetry(runId, {
      now,
      random: () => 0.5,
      retryReason: INTERACTION_CONTINUATION_INFRA_RETRY_REASON,
      wakeReason: INTERACTION_CONTINUATION_INFRA_WAKE_REASON,
      maxAttempts: 3,
    });

    expect(scheduled.outcome).toBe("scheduled");
    if (scheduled.outcome !== "scheduled") return;

    const issue = await db
      .select({
        executionRunId: issues.executionRunId,
        executionWorkspaceId: issues.executionWorkspaceId,
        executionWorkspacePreference: issues.executionWorkspacePreference,
        executionWorkspaceSettings: issues.executionWorkspaceSettings,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue).toMatchObject({
      executionRunId: scheduled.run.id,
      executionWorkspaceId: null,
      executionWorkspacePreference: null,
      executionWorkspaceSettings: { mode: "isolated_workspace" },
    });

    const workspace = await db
      .select({
        status: executionWorkspaces.status,
        closedAt: executionWorkspaces.closedAt,
        cleanupEligibleAt: executionWorkspaces.cleanupEligibleAt,
        cleanupReason: executionWorkspaces.cleanupReason,
        metadata: executionWorkspaces.metadata,
      })
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, executionWorkspaceId))
      .then((rows) => rows[0] ?? null);
    expect(workspace).toMatchObject({
      status: "archived",
      cleanupEligibleAt: null,
      cleanupReason: "workspace_validation_failed",
    });
    expect(workspace?.closedAt?.toISOString()).toBe(now.toISOString());
    expect(workspace?.metadata).toMatchObject({
      existing: true,
      workspaceValidationQuarantine: {
        reason: "workspace_validation_failed",
        retryReason: INTERACTION_CONTINUATION_INFRA_RETRY_REASON,
        sourceRunId: runId,
        retryRunId: scheduled.run.id,
        issueId,
        sourceIssueId: issueId,
        workspaceValidation: validation,
      },
    });

    const retryRun = await db
      .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, scheduled.run.id))
      .then((rows) => rows[0] ?? null);
    expect(retryRun?.contextSnapshot).toMatchObject({
      workspaceValidationRecovery: {
        strategy: "quarantine_failed_workspace_and_retry_clean",
        sourceRunId: runId,
        reason: "git_worktree_branch_incoherence",
        fingerprint: validation.fingerprint,
        failedExecutionWorkspaceId: executionWorkspaceId,
      },
    });

    const activity = await db
      .select({ action: activityLog.action, entityId: activityLog.entityId, details: activityLog.details })
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.action, "execution_workspace.workspace_validation_quarantined"),
      ))
      .then((rows) => rows[0] ?? null);
    expect(activity).toMatchObject({
      action: "execution_workspace.workspace_validation_quarantined",
      entityId: executionWorkspaceId,
      details: expect.objectContaining({
        retryRunId: scheduled.run.id,
        workspaceValidation: validation,
      }),
    });

    const agent = await db
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0] ?? null);
    expect(agent?.id).toBe(agentId);
  });

  it("does not quarantine another issue's workspace when validation payload is stale", async () => {
    const { companyId, issueId, runId, now } = await seedMaxTurnFixture({ issueStatus: "in_review" });
    const projectId = randomUUID();
    const currentWorkspaceId = randomUUID();
    const foreignIssueId = randomUUID();
    const foreignWorkspaceId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const validation = {
      reason: "git_worktree_branch_incoherence",
      fingerprint: "workspace_incoherence:v1:sha256:stale",
      executionWorkspaceId: foreignWorkspaceId,
      expectedBranch: "current-issue-branch",
      actualBranch: "foreign-issue-branch",
      cleanliness: "clean",
    };

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Paperclip App",
      status: "in_progress",
    });
    await db.insert(issues).values({
      id: foreignIssueId,
      companyId,
      title: "Other active issue",
      status: "in_progress",
      priority: "medium",
      responsibleUserId: "responsible-user",
      issueNumber: 2,
      identifier: `${issuePrefix}-2`,
    });
    await db.insert(executionWorkspaces).values([
      {
        id: currentWorkspaceId,
        companyId,
        projectId,
        sourceIssueId: issueId,
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        name: "current-issue-branch",
        status: "active",
        cwd: "/workspace/current-issue-branch",
        baseRef: "origin/master",
        branchName: "current-issue-branch",
        providerType: "git_worktree",
        providerRef: "/workspace/current-issue-branch",
        metadata: { current: true },
      },
      {
        id: foreignWorkspaceId,
        companyId,
        projectId,
        sourceIssueId: foreignIssueId,
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        name: "foreign-issue-branch",
        status: "active",
        cwd: "/workspace/foreign-issue-branch",
        baseRef: "origin/master",
        branchName: "foreign-issue-branch",
        providerType: "git_worktree",
        providerRef: "/workspace/foreign-issue-branch",
        metadata: { foreign: true },
      },
    ]);
    await db
      .update(issues)
      .set({
        projectId,
        executionWorkspaceId: foreignWorkspaceId,
        executionWorkspacePreference: "reuse_existing",
        executionWorkspaceSettings: { mode: "isolated_workspace" },
      })
      .where(eq(issues.id, issueId));

    const interactionId = randomUUID();
    await db
      .update(heartbeatRuns)
      .set({
        error: "workspace validation failed before dispatch",
        errorCode: "workspace_validation_failed",
        resultJson: { workspaceValidation: validation },
        contextSnapshot: {
          issueId,
          taskId: issueId,
          wakeReason: "issue_commented",
          mutation: "interaction",
          interactionId,
          interactionKind: "request_confirmation",
          interactionStatus: "accepted",
        },
      })
      .where(eq(heartbeatRuns.id, runId));

    const scheduled = await heartbeat.scheduleBoundedRetry(runId, {
      now,
      random: () => 0.5,
      retryReason: INTERACTION_CONTINUATION_INFRA_RETRY_REASON,
      wakeReason: INTERACTION_CONTINUATION_INFRA_WAKE_REASON,
      maxAttempts: 3,
    });

    expect(scheduled.outcome).toBe("scheduled");
    if (scheduled.outcome !== "scheduled") return;

    const issue = await db
      .select({
        executionRunId: issues.executionRunId,
        executionWorkspaceId: issues.executionWorkspaceId,
        executionWorkspacePreference: issues.executionWorkspacePreference,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue).toMatchObject({
      executionRunId: scheduled.run.id,
      executionWorkspaceId: foreignWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
    });

    const workspaces = await db
      .select({ id: executionWorkspaces.id, status: executionWorkspaces.status, metadata: executionWorkspaces.metadata })
      .from(executionWorkspaces)
      .where(inArray(executionWorkspaces.id, [currentWorkspaceId, foreignWorkspaceId]));
    expect(workspaces).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: currentWorkspaceId, status: "active", metadata: { current: true } }),
      expect.objectContaining({ id: foreignWorkspaceId, status: "active", metadata: { foreign: true } }),
    ]));

    const activity = await db
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.action, "execution_workspace.workspace_validation_quarantined"),
      ));
    expect(activity).toHaveLength(0);
  });

  it("does not quarantine an owned workspace that is no longer attached to the issue", async () => {
    const { companyId, issueId, runId, now } = await seedMaxTurnFixture({ issueStatus: "in_review" });
    const projectId = randomUUID();
    const staleWorkspaceId = randomUUID();
    const currentWorkspaceId = randomUUID();
    const validation = {
      reason: "git_worktree_branch_incoherence",
      fingerprint: "workspace_incoherence:v1:sha256:stale-owned",
      executionWorkspaceId: staleWorkspaceId,
      expectedBranch: "old-plan-approval-workspace",
      actualBranch: "current-plan-approval-workspace",
      cleanliness: "clean",
    };

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Paperclip App",
      status: "in_progress",
    });
    await db.insert(executionWorkspaces).values([
      {
        id: staleWorkspaceId,
        companyId,
        projectId,
        sourceIssueId: issueId,
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        name: "old-plan-approval-workspace",
        status: "active",
        cwd: "/workspace/old-plan-approval-workspace",
        baseRef: "origin/master",
        branchName: "old-plan-approval-workspace",
        providerType: "git_worktree",
        providerRef: "/workspace/old-plan-approval-workspace",
        metadata: { stale: true },
      },
      {
        id: currentWorkspaceId,
        companyId,
        projectId,
        sourceIssueId: issueId,
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        name: "current-plan-approval-workspace",
        status: "active",
        cwd: "/workspace/current-plan-approval-workspace",
        baseRef: "origin/master",
        branchName: "current-plan-approval-workspace",
        providerType: "git_worktree",
        providerRef: "/workspace/current-plan-approval-workspace",
        metadata: { current: true },
      },
    ]);
    await db
      .update(issues)
      .set({
        projectId,
        executionWorkspaceId: currentWorkspaceId,
        executionWorkspacePreference: "reuse_existing",
        executionWorkspaceSettings: { mode: "isolated_workspace" },
      })
      .where(eq(issues.id, issueId));

    const interactionId = randomUUID();
    await db
      .update(heartbeatRuns)
      .set({
        error: "workspace validation failed before dispatch",
        errorCode: "workspace_validation_failed",
        resultJson: { workspaceValidation: validation },
        contextSnapshot: {
          issueId,
          taskId: issueId,
          wakeReason: "issue_commented",
          mutation: "interaction",
          interactionId,
          interactionKind: "request_confirmation",
          interactionStatus: "accepted",
        },
      })
      .where(eq(heartbeatRuns.id, runId));

    const scheduled = await heartbeat.scheduleBoundedRetry(runId, {
      now,
      random: () => 0.5,
      retryReason: INTERACTION_CONTINUATION_INFRA_RETRY_REASON,
      wakeReason: INTERACTION_CONTINUATION_INFRA_WAKE_REASON,
      maxAttempts: 3,
    });

    expect(scheduled.outcome).toBe("scheduled");
    if (scheduled.outcome !== "scheduled") return;

    const issue = await db
      .select({
        executionRunId: issues.executionRunId,
        executionWorkspaceId: issues.executionWorkspaceId,
        executionWorkspacePreference: issues.executionWorkspacePreference,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue).toMatchObject({
      executionRunId: scheduled.run.id,
      executionWorkspaceId: currentWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
    });

    const workspaces = await db
      .select({ id: executionWorkspaces.id, status: executionWorkspaces.status, metadata: executionWorkspaces.metadata })
      .from(executionWorkspaces)
      .where(inArray(executionWorkspaces.id, [staleWorkspaceId, currentWorkspaceId]));
    expect(workspaces).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: staleWorkspaceId, status: "active", metadata: { stale: true } }),
      expect.objectContaining({ id: currentWorkspaceId, status: "active", metadata: { current: true } }),
    ]));

    const activity = await db
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.action, "execution_workspace.workspace_validation_quarantined"),
      ));
    expect(activity).toHaveLength(0);
  });

  it("does not schedule accepted interaction continuation infra retries after terminal issue status", async () => {
    const { issueId, runId, now } = await seedMaxTurnFixture({ issueStatus: "done" });

    await db
      .update(heartbeatRuns)
      .set({
        error: "workspace validation failed before dispatch",
        errorCode: "workspace_validation_failed",
        resultJson: {},
        contextSnapshot: {
          issueId,
          taskId: issueId,
          wakeReason: "issue_commented",
          mutation: "interaction",
          interactionId: randomUUID(),
          interactionKind: "request_confirmation",
          interactionStatus: "accepted",
        },
      })
      .where(eq(heartbeatRuns.id, runId));

    const scheduled = await heartbeat.scheduleBoundedRetry(runId, {
      now,
      retryReason: INTERACTION_CONTINUATION_INFRA_RETRY_REASON,
      wakeReason: INTERACTION_CONTINUATION_INFRA_WAKE_REASON,
      maxAttempts: 3,
    });

    expect(scheduled).toMatchObject({
      outcome: "not_scheduled",
      errorCode: "issue_terminal_status",
      issueId,
    });
  });

  it("coalesces duplicate max-turn continuation schedules for the same source run and attempt", async () => {
    const { issueId, runId, now } = await seedMaxTurnFixture();
    const retryOptions = {
      now,
      retryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
      wakeReason: MAX_TURN_CONTINUATION_WAKE_REASON,
      maxAttempts: 2,
      delayMs: 1_000,
    };

    const [first, second] = await Promise.all([
      heartbeat.scheduleBoundedRetry(runId, retryOptions),
      heartbeat.scheduleBoundedRetry(runId, retryOptions),
    ]);

    expect(first.outcome).toBe("scheduled");
    expect(second.outcome).toBe("scheduled");
    if (first.outcome !== "scheduled" || second.outcome !== "scheduled") return;

    expect(new Set([first.run.id, second.run.id]).size).toBe(1);

    const retryRuns = await db
      .select({
        id: heartbeatRuns.id,
        wakeupRequestId: heartbeatRuns.wakeupRequestId,
      })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.retryOfRunId, runId),
          eq(heartbeatRuns.scheduledRetryReason, MAX_TURN_CONTINUATION_RETRY_REASON),
          eq(heartbeatRuns.scheduledRetryAttempt, 1),
        ),
      );
    expect(retryRuns).toHaveLength(1);

    const wakeups = await db
      .select({
        id: agentWakeupRequests.id,
        coalescedCount: agentWakeupRequests.coalescedCount,
        idempotencyKey: agentWakeupRequests.idempotencyKey,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.reason, MAX_TURN_CONTINUATION_WAKE_REASON));
    expect(wakeups).toHaveLength(1);
    expect(wakeups[0]).toMatchObject({
      id: retryRuns[0]?.wakeupRequestId,
      coalescedCount: 1,
    });
    expect(wakeups[0]?.idempotencyKey).toContain(`:${issueId}:${runId}:1`);

    const issue = await db
      .select({ executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.executionRunId).toBe(retryRuns[0]?.id);
  });

  it("does not promote a duplicate max-turn continuation that does not own the issue lock", async () => {
    const { companyId, agentId, issueId, runId, now } = await seedMaxTurnFixture();

    const scheduled = await heartbeat.scheduleBoundedRetry(runId, {
      now,
      retryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
      wakeReason: MAX_TURN_CONTINUATION_WAKE_REASON,
      maxAttempts: 2,
      delayMs: 1_000,
    });
    expect(scheduled.outcome).toBe("scheduled");
    if (scheduled.outcome !== "scheduled") return;

    const duplicateWakeupId = randomUUID();
    const duplicateRunId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: duplicateWakeupId,
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: MAX_TURN_CONTINUATION_WAKE_REASON,
      payload: {
        issueId,
        retryOfRunId: runId,
        retryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
        scheduledRetryAttempt: 1,
      },
      status: "queued",
      requestedByActorType: "system",
    });
    await db.insert(heartbeatRuns).values({
      id: duplicateRunId,
      companyId,
      agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "scheduled_retry",
      wakeupRequestId: duplicateWakeupId,
      retryOfRunId: runId,
      scheduledRetryAt: scheduled.dueAt,
      scheduledRetryAttempt: 1,
      scheduledRetryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
      contextSnapshot: {
        issueId,
        wakeReason: MAX_TURN_CONTINUATION_WAKE_REASON,
        retryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
      },
    });
    await db
      .update(agentWakeupRequests)
      .set({ runId: duplicateRunId })
      .where(eq(agentWakeupRequests.id, duplicateWakeupId));

    const promotion = await heartbeat.promoteDueScheduledRetries(scheduled.dueAt);
    expect(promotion).toEqual({ promoted: 1, runIds: [scheduled.run.id] });

    const duplicate = await db
      .select({
        status: heartbeatRuns.status,
        errorCode: heartbeatRuns.errorCode,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, duplicateRunId))
      .then((rows) => rows[0] ?? null);
    expect(duplicate).toEqual({
      status: "cancelled",
      errorCode: "issue_execution_lock_changed",
    });

    const duplicateWakeup = await db
      .select({ status: agentWakeupRequests.status })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, duplicateWakeupId))
      .then((rows) => rows[0] ?? null);
    expect(duplicateWakeup?.status).toBe("cancelled");
  });

  it.each(["blocked", "todo", "backlog"] as const)(
    "does not schedule a max-turn continuation when the issue is already %s",
    async (issueStatus) => {
      const { issueId, runId, now } = await seedMaxTurnFixture({ issueStatus });

      const scheduled = await heartbeat.scheduleBoundedRetry(runId, {
        now,
        retryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
        wakeReason: MAX_TURN_CONTINUATION_WAKE_REASON,
        maxAttempts: 2,
        delayMs: 1_000,
      });

      expect(scheduled).toMatchObject({
        outcome: "not_scheduled",
        errorCode: "issue_not_in_progress",
        issueId,
      });

      const retryRuns = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.retryOfRunId, runId))
        .then((rows) => rows[0]?.count ?? 0);
      expect(retryRuns).toBe(0);
    },
  );

  it.each(["blocked", "todo", "backlog"] as const)(
    "cancels a due max-turn continuation when the issue moves to %s before retry promotion",
    async (issueStatus) => {
      const { issueId, runId, now } = await seedMaxTurnFixture();

      const scheduled = await heartbeat.scheduleBoundedRetry(runId, {
        now,
        retryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
        wakeReason: MAX_TURN_CONTINUATION_WAKE_REASON,
        maxAttempts: 2,
        delayMs: 1_000,
      });
      expect(scheduled.outcome).toBe("scheduled");
      if (scheduled.outcome !== "scheduled") return;

      await db.update(issues).set({
        status: issueStatus,
        updatedAt: new Date(now.getTime() + 500),
      }).where(eq(issues.id, issueId));

      const promotion = await heartbeat.promoteDueScheduledRetries(scheduled.dueAt);
      expect(promotion).toEqual({ promoted: 0, runIds: [] });

      const retryRun = await db
        .select({
          status: heartbeatRuns.status,
          errorCode: heartbeatRuns.errorCode,
          wakeupRequestId: heartbeatRuns.wakeupRequestId,
        })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, scheduled.run.id))
        .then((rows) => rows[0] ?? null);
      expect(retryRun).toMatchObject({
        status: "cancelled",
        errorCode: "issue_not_in_progress",
      });

      const wakeupRequest = await db
        .select({ status: agentWakeupRequests.status })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, retryRun?.wakeupRequestId ?? ""))
        .then((rows) => rows[0] ?? null);
      expect(wakeupRequest?.status).toBe("cancelled");

      const issue = await db
        .select({
          executionRunId: issues.executionRunId,
          executionAgentNameKey: issues.executionAgentNameKey,
          executionLockedAt: issues.executionLockedAt,
        })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null);
      expect(issue).toEqual({
        executionRunId: null,
        executionAgentNameKey: null,
        executionLockedAt: null,
      });

      const event = await db
        .select({
          message: heartbeatRunEvents.message,
          payload: heartbeatRunEvents.payload,
        })
        .from(heartbeatRunEvents)
        .where(eq(heartbeatRunEvents.runId, scheduled.run.id))
        .orderBy(sql`${heartbeatRunEvents.seq} desc`)
        .then((rows) => rows[0] ?? null);
      expect(event?.message).toContain("no longer in_progress");
      expect(event?.payload).toMatchObject({
        currentStatus: issueStatus,
        requiredStatus: "in_progress",
        scheduledRetryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
      });
    },
  );

  it("does not queue max-turn continuations after the configured cap", async () => {
    const { runId, now } = await seedMaxTurnFixture({ scheduledRetryAttempt: 2 });

    const exhausted = await heartbeat.scheduleBoundedRetry(runId, {
      now,
      retryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
      wakeReason: MAX_TURN_CONTINUATION_WAKE_REASON,
      maxAttempts: 2,
      delayMs: 1_000,
    });

    expect(exhausted).toEqual({
      outcome: "retry_exhausted",
      attempt: 3,
      maxAttempts: 2,
    });

    const runCount = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(heartbeatRuns)
      .then((rows) => rows[0]?.count ?? 0);
    expect(runCount).toBe(1);

    const exhaustionEvent = await db
      .select({ message: heartbeatRunEvents.message, payload: heartbeatRunEvents.payload })
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, runId))
      .orderBy(sql`${heartbeatRunEvents.id} desc`)
      .then((rows) => rows[0] ?? null);
    expect(exhaustionEvent?.message).toContain("Bounded retry exhausted");
    expect(exhaustionEvent?.payload).toMatchObject({
      retryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
      maxAttempts: 2,
    });
  });

  it("suppresses max-turn continuation scheduling when budget or dependencies block the issue", async () => {
    const budgetBlocked = await seedMaxTurnFixture({ now: new Date("2026-04-20T16:00:00.000Z") });
    await db.insert(budgetPolicies).values({
      companyId: budgetBlocked.companyId,
      scopeType: "agent",
      scopeId: budgetBlocked.agentId,
      windowKind: "monthly",
      metric: "billed_cents",
      amount: 0,
      hardStopEnabled: true,
      isActive: true,
    });
    await db
      .update(agents)
      .set({ status: "paused", pauseReason: "budget" })
      .where(eq(agents.id, budgetBlocked.agentId));

    const budgetResult = await heartbeat.scheduleBoundedRetry(budgetBlocked.runId, {
      now: budgetBlocked.now,
      retryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
      wakeReason: MAX_TURN_CONTINUATION_WAKE_REASON,
      maxAttempts: 2,
      delayMs: 1_000,
    });
    expect(budgetResult).toMatchObject({
      outcome: "not_scheduled",
      errorCode: "budget_blocked",
      issueId: budgetBlocked.issueId,
    });

    await cleanupRetryFixture();

    const dependencyBlocked = await seedMaxTurnFixture({ now: new Date("2026-04-20T17:00:00.000Z") });
    const blockerId = randomUUID();
    await db.insert(issues).values({
      id: blockerId,
      companyId: dependencyBlocked.companyId,
      title: "Blocker",
      status: "todo",
      priority: "medium",
      responsibleUserId: "responsible-user",
      issueNumber: 2,
      identifier: `T${dependencyBlocked.companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}-2`,
    });
    await db.insert(issueRelations).values({
      companyId: dependencyBlocked.companyId,
      issueId: blockerId,
      relatedIssueId: dependencyBlocked.issueId,
      type: "blocks",
    });

    const dependencyResult = await heartbeat.scheduleBoundedRetry(dependencyBlocked.runId, {
      now: dependencyBlocked.now,
      retryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
      wakeReason: MAX_TURN_CONTINUATION_WAKE_REASON,
      maxAttempts: 2,
      delayMs: 1_000,
    });
    expect(dependencyResult).toMatchObject({
      outcome: "not_scheduled",
      errorCode: "issue_dependencies_blocked",
      issueId: dependencyBlocked.issueId,
    });

    const retryRuns = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.retryOfRunId, dependencyBlocked.runId))
      .then((rows) => rows[0]?.count ?? 0);
    expect(retryRuns).toBe(0);
  });

  it("does not defer a new assignee behind the previous assignee's scheduled retry", async () => {
    const companyId = randomUUID();
    const oldAgentId = randomUUID();
    const newAgentId = randomUUID();
    const issueId = randomUUID();
    const sourceRunId = randomUUID();
    const now = new Date("2026-04-20T13:00:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });

    await db.insert(agents).values([
      {
        id: oldAgentId,
        companyId,
        name: "ClaudeCoder",
        role: "engineer",
        status: "active",
        adapterType: "claude_local",
        adapterConfig: {},
        runtimeConfig: {
          heartbeat: {
            wakeOnDemand: true,
            maxConcurrentRuns: 1,
          },
        },
        permissions: {},
      },
      {
        id: newAgentId,
        companyId,
        name: "CodexCoder",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {
          heartbeat: {
            wakeOnDemand: true,
            maxConcurrentRuns: 1,
          },
        },
        permissions: {},
      },
    ]);

    await db.insert(heartbeatRuns).values({
      id: sourceRunId,
      companyId,
      agentId: oldAgentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "failed",
      error: "upstream overload",
      errorCode: "adapter_failed",
      finishedAt: now,
      contextSnapshot: {
        issueId,
        wakeReason: "issue_assigned",
      },
      updatedAt: now,
      createdAt: now,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Retry reassignment",
      status: "todo",
      priority: "medium",
      responsibleUserId: "responsible-user",
      assigneeAgentId: oldAgentId,
      executionRunId: sourceRunId,
      executionAgentNameKey: "claudecoder",
      executionLockedAt: now,
      issueNumber: 1,
      identifier: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}-1`,
    });

    const scheduled = await heartbeat.scheduleBoundedRetry(sourceRunId, {
      now,
      random: () => 0.5,
    });
    expect(scheduled.outcome).toBe("scheduled");
    if (scheduled.outcome !== "scheduled") return;

    await db.update(issues).set({
      assigneeAgentId: newAgentId,
      updatedAt: now,
    }).where(eq(issues.id, issueId));

    // Keep the new agent's queue from auto-claiming/executing during this unit test.
    await db.insert(heartbeatRuns).values(
      Array.from({ length: 5 }, () => ({
        id: randomUUID(),
        companyId,
        agentId: newAgentId,
        invocationSource: "automation",
        triggerDetail: "system",
        status: "running",
        contextSnapshot: {
          wakeReason: "test_busy_slot",
        },
        startedAt: now,
        updatedAt: now,
        createdAt: now,
      })),
    );

    const newAssigneeRun = await heartbeat.wakeup(newAgentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: {
        issueId,
        mutation: "update",
      },
      contextSnapshot: {
        issueId,
        source: "issue.update",
      },
      requestedByActorType: "user",
      requestedByActorId: "local-board",
    });

    expect(newAssigneeRun).not.toBeNull();
    expect(newAssigneeRun?.agentId).toBe(newAgentId);
    expect(newAssigneeRun?.status).toBe("queued");

    const oldRetry = await db
      .select({
        status: heartbeatRuns.status,
        errorCode: heartbeatRuns.errorCode,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, scheduled.run.id))
      .then((rows) => rows[0] ?? null);
    expect(oldRetry).toEqual({
      status: "cancelled",
      errorCode: "issue_reassigned",
    });

    const deferredWakeups = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.status, "deferred_issue_execution"))
      .then((rows) => rows[0]?.count ?? 0);
    expect(deferredWakeups).toBe(0);
  });

  it("does not promote a scheduled retry after issue ownership changes", async () => {
    const companyId = randomUUID();
    const oldAgentId = randomUUID();
    const newAgentId = randomUUID();
    const issueId = randomUUID();
    const sourceRunId = randomUUID();
    const now = new Date("2026-04-20T14:00:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });

    await db.insert(agents).values([
      {
        id: oldAgentId,
        companyId,
        name: "ClaudeCoder",
        role: "engineer",
        status: "active",
        adapterType: "claude_local",
        adapterConfig: {},
        runtimeConfig: {
          heartbeat: {
            wakeOnDemand: true,
            maxConcurrentRuns: 1,
          },
        },
        permissions: {},
      },
      {
        id: newAgentId,
        companyId,
        name: "CodexCoder",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {
          heartbeat: {
            wakeOnDemand: true,
            maxConcurrentRuns: 1,
          },
        },
        permissions: {},
      },
    ]);

    await db.insert(heartbeatRuns).values({
      id: sourceRunId,
      companyId,
      agentId: oldAgentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "failed",
      error: "upstream overload",
      errorCode: "adapter_failed",
      finishedAt: now,
      contextSnapshot: {
        issueId,
        wakeReason: "issue_assigned",
      },
      updatedAt: now,
      createdAt: now,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Retry promotion reassignment",
      status: "todo",
      priority: "medium",
      responsibleUserId: "responsible-user",
      assigneeAgentId: oldAgentId,
      executionRunId: sourceRunId,
      executionAgentNameKey: "claudecoder",
      executionLockedAt: now,
      issueNumber: 1,
      identifier: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}-2`,
    });

    const scheduled = await heartbeat.scheduleBoundedRetry(sourceRunId, {
      now,
      random: () => 0.5,
    });
    expect(scheduled.outcome).toBe("scheduled");
    if (scheduled.outcome !== "scheduled") return;

    await db.update(issues).set({
      assigneeAgentId: newAgentId,
      updatedAt: now,
    }).where(eq(issues.id, issueId));

    const promotion = await heartbeat.promoteDueScheduledRetries(scheduled.dueAt);
    expect(promotion).toEqual({ promoted: 0, runIds: [] });

    const oldRetry = await db
      .select({
        status: heartbeatRuns.status,
        errorCode: heartbeatRuns.errorCode,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, scheduled.run.id))
      .then((rows) => rows[0] ?? null);
    expect(oldRetry).toEqual({
      status: "cancelled",
      errorCode: "issue_reassigned",
    });

    const issue = await db
      .select({ executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.executionRunId).toBeNull();
  });

  it("does not promote a scheduled retry after the issue is handed to a human owner", async () => {
    const companyId = randomUUID();
    const oldAgentId = randomUUID();
    const issueId = randomUUID();
    const sourceRunId = randomUUID();
    const now = new Date("2026-04-20T14:30:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });

    await db.insert(agents).values({
      id: oldAgentId,
      companyId,
      name: "ClaudeCoder",
      role: "engineer",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: sourceRunId,
      companyId,
      agentId: oldAgentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "failed",
      error: "upstream overload",
      errorCode: "adapter_failed",
      finishedAt: now,
      contextSnapshot: {
        issueId,
        wakeReason: "issue_assigned",
      },
      updatedAt: now,
      createdAt: now,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Retry human handoff",
      status: "in_progress",
      priority: "medium",
      responsibleUserId: "responsible-user",
      assigneeAgentId: oldAgentId,
      executionRunId: sourceRunId,
      executionAgentNameKey: "claudecoder",
      executionLockedAt: now,
      issueNumber: 1,
      identifier: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}-3`,
    });

    const scheduled = await heartbeat.scheduleBoundedRetry(sourceRunId, {
      now,
      random: () => 0.5,
    });
    expect(scheduled.outcome).toBe("scheduled");
    if (scheduled.outcome !== "scheduled") return;

    await db.update(issues).set({
      assigneeAgentId: null,
      assigneeUserId: "local-board",
      updatedAt: now,
    }).where(eq(issues.id, issueId));

    const promotion = await heartbeat.promoteDueScheduledRetries(scheduled.dueAt);
    expect(promotion).toEqual({ promoted: 0, runIds: [] });

    const oldRetry = await db
      .select({
        status: heartbeatRuns.status,
        errorCode: heartbeatRuns.errorCode,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, scheduled.run.id))
      .then((rows) => rows[0] ?? null);
    expect(oldRetry).toEqual({
      status: "cancelled",
      errorCode: "issue_reassigned",
    });

    const issue = await db
      .select({
        assigneeAgentId: issues.assigneeAgentId,
        assigneeUserId: issues.assigneeUserId,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue).toMatchObject({
      assigneeAgentId: null,
      assigneeUserId: "local-board",
      executionRunId: null,
    });
  });

  it("does not promote a scheduled retry after the issue is cancelled", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const sourceRunId = randomUUID();
    const now = new Date("2026-04-20T15:00:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: sourceRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "failed",
      error: "upstream overload",
      errorCode: "adapter_failed",
      finishedAt: now,
      contextSnapshot: {
        issueId,
        wakeReason: "issue_assigned",
      },
      updatedAt: now,
      createdAt: now,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Retry promotion cancellation",
      status: "todo",
      priority: "medium",
      responsibleUserId: "responsible-user",
      assigneeAgentId: agentId,
      executionRunId: sourceRunId,
      executionAgentNameKey: "codexcoder",
      executionLockedAt: now,
      issueNumber: 1,
      identifier: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}-3`,
    });

    const scheduled = await heartbeat.scheduleBoundedRetry(sourceRunId, {
      now,
      random: () => 0.5,
    });
    expect(scheduled.outcome).toBe("scheduled");
    if (scheduled.outcome !== "scheduled") return;

    await db.update(issues).set({
      status: "cancelled",
      updatedAt: now,
    }).where(eq(issues.id, issueId));

    const promotion = await heartbeat.promoteDueScheduledRetries(scheduled.dueAt);
    expect(promotion).toEqual({ promoted: 0, runIds: [] });

    const oldRetry = await db
      .select({
        status: heartbeatRuns.status,
        errorCode: heartbeatRuns.errorCode,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, scheduled.run.id))
      .then((rows) => rows[0] ?? null);
    expect(oldRetry).toEqual({
      status: "cancelled",
      errorCode: "issue_cancelled",
    });

    const issue = await db
      .select({ executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.executionRunId).toBeNull();
  });

  it("exhausts bounded retries after the hard cap", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const cappedRunId = randomUUID();
    const now = new Date("2026-04-20T18:00:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: cappedRunId,
      companyId,
      agentId,
      invocationSource: "automation",
      status: "failed",
      error: "still transient",
      errorCode: "adapter_failed",
      finishedAt: now,
      scheduledRetryAttempt: BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS.length,
      scheduledRetryReason: "transient_failure",
      contextSnapshot: {
        wakeReason: "transient_failure_retry",
      },
      updatedAt: now,
      createdAt: now,
    });

    const exhausted = await heartbeat.scheduleBoundedRetry(cappedRunId, {
      now,
      random: () => 0.5,
    });

    expect(exhausted).toEqual({
      outcome: "retry_exhausted",
      attempt: BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS.length + 1,
      maxAttempts: BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS.length,
    });

    const runCount = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.companyId, companyId))
      .then((rows) => rows[0]?.count ?? 0);
    expect(runCount).toBe(1);

    const exhaustionEvent = await db
      .select({
        message: heartbeatRunEvents.message,
        payload: heartbeatRunEvents.payload,
      })
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, cappedRunId))
      .orderBy(sql`${heartbeatRunEvents.id} desc`)
      .then((rows) => rows[0] ?? null);

    expect(exhaustionEvent?.message).toContain("Bounded retry exhausted");
    expect(exhaustionEvent?.payload).toMatchObject({
      retryReason: "transient_failure",
      scheduledRetryAttempt: BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS.length,
      maxAttempts: BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS.length,
    });
  });

  it("keeps provider-quota recovery scheduled beyond the generic retry cap", async () => {
    const now = new Date("2026-04-20T18:00:00.000Z");
    const resetAt = new Date("2026-04-21T06:00:00.000Z");
    const fixture = {
      companyId: randomUUID(),
      agentId: randomUUID(),
      runId: randomUUID(),
    };
    await seedRetryFixture({
      ...fixture,
      now,
      errorCode: "provider_quota",
      errorFamily: "provider_quota",
      retryNotBefore: resetAt.toISOString(),
      scheduledRetryAttempt: BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS.length,
      resultJson: {
        errorFamily: "provider_quota",
        retryNotBefore: resetAt.toISOString(),
      },
    });

    const scheduled = await heartbeat.scheduleBoundedRetry(fixture.runId, {
      now,
      random: () => 0.5,
    });

    expect(scheduled.outcome).toBe("scheduled");
    if (scheduled.outcome !== "scheduled") return;
    expect(scheduled.attempt).toBe(BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS.length + 1);
    expect(scheduled.maxAttempts).toBe(scheduled.attempt);
    expect(scheduled.dueAt).toEqual(resetAt);
  });

  it("advances codex transient fallback stages across bounded retry attempts", async () => {
    const fallbackModes = [
      "same_session",
      "safer_invocation",
      "fresh_session",
      "fresh_session_safer_invocation",
    ] as const;

    for (const [index, expectedMode] of fallbackModes.entries()) {
      const companyId = randomUUID();
      const agentId = randomUUID();
      const runId = randomUUID();
      const now = new Date(`2026-04-20T1${index}:00:00.000Z`);

      await seedRetryFixture({
        runId,
        companyId,
        agentId,
        now,
        errorCode: "adapter_failed",
        errorFamily: "transient_upstream",
        scheduledRetryAttempt: index,
      });

      const scheduled = await heartbeat.scheduleBoundedRetry(runId, {
        now,
        random: () => 0.5,
      });

      expect(scheduled.outcome).toBe("scheduled");
      if (scheduled.outcome !== "scheduled") continue;

      const retryRun = await db
        .select({
          contextSnapshot: heartbeatRuns.contextSnapshot,
          wakeupRequestId: heartbeatRuns.wakeupRequestId,
        })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, scheduled.run.id))
        .then((rows) => rows[0] ?? null);
      expect((retryRun?.contextSnapshot as Record<string, unknown> | null)?.codexTransientFallbackMode).toBe(expectedMode);

      const wakeupRequest = await db
        .select({ payload: agentWakeupRequests.payload })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, retryRun?.wakeupRequestId ?? ""))
        .then((rows) => rows[0] ?? null);
      expect((wakeupRequest?.payload as Record<string, unknown> | null)?.codexTransientFallbackMode).toBe(expectedMode);

      await cleanupRetryFixture();
    }
  });

  it("schedules a recovery continuation for codex harness crashes", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const now = new Date("2026-07-24T12:00:00.000Z");

    await seedRetryFixture({
      runId,
      companyId,
      agentId,
      now,
      errorCode: "codex_harness_crash",
      errorFamily: "transient_upstream",
    });

    const scheduled = await heartbeat.scheduleBoundedRetry(runId, {
      now,
      random: () => 0.5,
    });

    expect(scheduled.outcome).toBe("scheduled");
    if (scheduled.outcome !== "scheduled") return;

    expect(scheduled.run.scheduledRetryAttempt).toBe(1);
    expect(scheduled.run.scheduledRetryReason).toBe("transient_failure");
    const contextSnapshot = scheduled.run.contextSnapshot as Record<string, unknown>;
    expect(contextSnapshot.codexTransientFallbackMode).toBe("same_session");
    expect(contextSnapshot.retryOfRunId).toBe(runId);

    await cleanupRetryFixture();
  });

  it("schedules a harness-crash recovery from the error code alone when the result json lost the error family", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const now = new Date("2026-07-24T13:00:00.000Z");

    await seedRetryFixture({
      runId,
      companyId,
      agentId,
      now,
      errorCode: "codex_harness_crash",
      errorFamily: null,
    });

    const scheduled = await heartbeat.scheduleBoundedRetry(runId, {
      now,
      random: () => 0.5,
    });

    expect(scheduled.outcome).toBe("scheduled");
    if (scheduled.outcome !== "scheduled") return;
    expect(scheduled.run.scheduledRetryReason).toBe("transient_failure");
    expect((scheduled.run.contextSnapshot as Record<string, unknown>).codexTransientFallbackMode).toBe("same_session");

    await cleanupRetryFixture();
  });

  it("honors codex retry-not-before timestamps when they exceed the default bounded backoff", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const now = new Date(2026, 3, 22, 22, 29, 0);
    const retryNotBefore = new Date(2026, 3, 22, 23, 31, 0);

    await seedRetryFixture({
      runId,
      companyId,
      agentId,
      now,
      errorCode: "adapter_failed",
      errorFamily: "transient_upstream",
      retryNotBefore: retryNotBefore.toISOString(),
    });

    const scheduled = await heartbeat.scheduleBoundedRetry(runId, {
      now,
      random: () => 0.5,
    });

    expect(scheduled.outcome).toBe("scheduled");
    if (scheduled.outcome !== "scheduled") return;
    expect(scheduled.dueAt.getTime()).toBe(retryNotBefore.getTime());

    const retryRun = await db
      .select({
        contextSnapshot: heartbeatRuns.contextSnapshot,
        scheduledRetryAt: heartbeatRuns.scheduledRetryAt,
        wakeupRequestId: heartbeatRuns.wakeupRequestId,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, scheduled.run.id))
      .then((rows) => rows[0] ?? null);

    expect(retryRun?.scheduledRetryAt?.getTime()).toBe(retryNotBefore.getTime());
    expect((retryRun?.contextSnapshot as Record<string, unknown> | null)?.transientRetryNotBefore).toBe(
      retryNotBefore.toISOString(),
    );

    const wakeupRequest = await db
      .select({ payload: agentWakeupRequests.payload })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, retryRun?.wakeupRequestId ?? ""))
      .then((rows) => rows[0] ?? null);

    expect((wakeupRequest?.payload as Record<string, unknown> | null)?.transientRetryNotBefore).toBe(
      retryNotBefore.toISOString(),
    );
  });

  it("schedules bounded retries for claude_transient_upstream and honors its retry-not-before hint", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const now = new Date(2026, 3, 22, 10, 0, 0);
    const retryNotBefore = new Date(2026, 3, 22, 16, 0, 0);

    await seedRetryFixture({
      runId,
      companyId,
      agentId,
      now,
      errorCode: "adapter_failed",
      errorFamily: "transient_upstream",
      adapterType: "claude_local",
      retryNotBefore: retryNotBefore.toISOString(),
    });

    const scheduled = await heartbeat.scheduleBoundedRetry(runId, {
      now,
      random: () => 0.5,
    });

    expect(scheduled.outcome).toBe("scheduled");
    if (scheduled.outcome !== "scheduled") return;
    expect(scheduled.dueAt.getTime()).toBe(retryNotBefore.getTime());

    const retryRun = await db
      .select({
        contextSnapshot: heartbeatRuns.contextSnapshot,
        scheduledRetryAt: heartbeatRuns.scheduledRetryAt,
        wakeupRequestId: heartbeatRuns.wakeupRequestId,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, scheduled.run.id))
      .then((rows) => rows[0] ?? null);

    expect(retryRun?.scheduledRetryAt?.getTime()).toBe(retryNotBefore.getTime());
    const contextSnapshot = (retryRun?.contextSnapshot as Record<string, unknown> | null) ?? {};
    expect(contextSnapshot.transientRetryNotBefore).toBe(retryNotBefore.toISOString());
    // Claude does not participate in the Codex fallback-mode ladder.
    expect(contextSnapshot.codexTransientFallbackMode ?? null).toBeNull();

    const wakeupRequest = await db
      .select({ payload: agentWakeupRequests.payload })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, retryRun?.wakeupRequestId ?? ""))
      .then((rows) => rows[0] ?? null);

    expect((wakeupRequest?.payload as Record<string, unknown> | null)?.transientRetryNotBefore).toBe(
      retryNotBefore.toISOString(),
    );
  });
});
