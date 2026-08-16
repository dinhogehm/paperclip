import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentWakeupRequestService } from "../services/agent-wakeup-requests.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres wakeup-request service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("agent wakeup request service", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let foreignCompanyId!: string;
  let agentId!: string;
  let foreignAgentId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("agent-wakeup-request-service-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  beforeEach(async () => {
    companyId = randomUUID();
    foreignCompanyId = randomUUID();
    agentId = randomUUID();
    foreignAgentId = randomUUID();

    await db.insert(companies).values([
      {
        id: companyId,
        name: "Primary company",
        issuePrefix: `A${companyId.replaceAll("-", "").slice(0, 5).toUpperCase()}`,
      },
      {
        id: foreignCompanyId,
        name: "Foreign company",
        issuePrefix: `B${foreignCompanyId.replaceAll("-", "").slice(0, 5).toUpperCase()}`,
      },
    ]);
    await db.insert(agents).values([
      {
        id: agentId,
        companyId,
        name: "Primary agent",
        adapterType: "process",
      },
      {
        id: foreignAgentId,
        companyId: foreignCompanyId,
        name: "Foreign agent",
        adapterType: "process",
      },
    ]);
  });

  afterEach(async () => {
    await db.delete(agentWakeupRequests);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function insertWakeupRequest(input: {
    status: string;
    runId?: string | null;
  }) {
    return db
      .insert(agentWakeupRequests)
      .values({
        companyId,
        agentId,
        source: "assignment",
        reason: "Original wake reason",
        status: input.status,
        runId: input.runId ?? null,
      })
      .returning()
      .then((rows) => rows[0]!);
  }

  it.each(["queued", "deferred_issue_execution"] as const)(
    "cancels an unclaimed %s request with a compare-and-set update",
    async (status) => {
      const wakeupRequest = await insertWakeupRequest({ status });
      const service = agentWakeupRequestService(db);

      const result = await service.cancel(wakeupRequest.id, companyId, "Operator reconciliation");

      expect(result).toMatchObject({
        outcome: "cancelled",
        previousStatus: status,
        wakeupRequest: {
          id: wakeupRequest.id,
          companyId,
          status: "cancelled",
          runId: null,
          error: "Operator reconciliation",
        },
      });
      expect(result?.wakeupRequest.finishedAt).toBeInstanceOf(Date);
    },
  );

  it("returns already_cancelled without overwriting the first reason or timestamp", async () => {
    const wakeupRequest = await insertWakeupRequest({ status: "queued" });
    const service = agentWakeupRequestService(db);

    const first = await service.cancel(wakeupRequest.id, companyId, "First operator reason");
    const repeated = await service.cancel(wakeupRequest.id, companyId, "Second operator reason");

    expect(first?.outcome).toBe("cancelled");
    expect(repeated).toMatchObject({
      outcome: "already_cancelled",
      wakeupRequest: {
        status: "cancelled",
        error: "First operator reason",
      },
    });
    expect(repeated?.wakeupRequest.finishedAt?.getTime()).toBe(
      first?.wakeupRequest.finishedAt?.getTime(),
    );
  });

  it("does not find or change a request through a foreign company scope", async () => {
    const wakeupRequest = await insertWakeupRequest({ status: "deferred_issue_execution" });
    const service = agentWakeupRequestService(db);

    const result = await service.cancel(
      wakeupRequest.id,
      foreignCompanyId,
      "Foreign operator reason",
    );
    const persisted = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeupRequest.id))
      .then((rows) => rows[0]!);

    expect(result).toBeNull();
    expect(persisted).toMatchObject({
      companyId,
      status: "deferred_issue_execution",
      error: null,
      finishedAt: null,
    });
  });

  it.each([
    { status: "claimed", runId: null },
    { status: "queued", runId: randomUUID() },
  ])("protects a $status request with run $runId", async ({ status, runId }) => {
    const wakeupRequest = await insertWakeupRequest({ status, runId });
    const service = agentWakeupRequestService(db);

    const result = await service.cancel(wakeupRequest.id, companyId, "Must not cancel");
    const persisted = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeupRequest.id))
      .then((rows) => rows[0]!);

    expect(result).toMatchObject({
      outcome: "conflict",
      reason: "claimed_or_run_bound",
      wakeupRequest: { status, runId },
    });
    expect(persisted).toMatchObject({
      status,
      runId,
      error: null,
      finishedAt: null,
    });
  });
});
