import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentConfigRevisions,
  agents,
  companies,
  createDb,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import { agentAssignmentsService } from "./agent-assignments.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("agent assignment snapshots", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-assignment-snapshot-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("returns each complete agent and its latest revision from the atomic GET query", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const oldRevisionId = randomUUID();
    const latestRevisionId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Atomic assignments",
      issuePrefix: "ATM",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Snapshot worker",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      codexAccountMode: "host",
      claudeAccountMode: "first_available",
      adapterConfig: { model: "gpt-test" },
      runtimeConfig: { heartbeat: { wakeOnDemand: true } },
      permissions: {},
    });
    await db.insert(agentConfigRevisions).values([
      {
        id: oldRevisionId,
        companyId,
        agentId,
        source: "test",
        changedKeys: ["adapterType"],
        beforeConfig: {},
        afterConfig: { adapterType: "codex_local" },
        createdAt: new Date("2026-08-15T12:00:00.000Z"),
      },
      {
        id: latestRevisionId,
        companyId,
        agentId,
        source: "test",
        changedKeys: ["claudeAccountMode"],
        beforeConfig: { claudeAccountMode: "host" },
        afterConfig: { claudeAccountMode: "first_available" },
        createdAt: new Date("2026-08-15T12:01:00.000Z"),
      },
    ]);

    const result = await agentAssignmentsService(db).list(companyId);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      assignmentVersion: latestRevisionId,
      agent: {
        id: agentId,
        companyId,
        name: "Snapshot worker",
        adapterType: "codex_local",
        codexAccountMode: "host",
        claudeAccountMode: "first_available",
        adapterConfig: { model: "gpt-test" },
        runtimeConfig: { heartbeat: { wakeOnDemand: true } },
      },
    });
  });
});
