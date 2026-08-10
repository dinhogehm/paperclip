import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { codexAccountRoutes } from "../routes/codex-accounts.js";

const companyId = "11111111-1111-4111-8111-111111111111";
const accountId = "22222222-2222-4222-8222-222222222222";
const agentId = "33333333-3333-4333-8333-333333333333";

const mockService = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  startLogin: vi.fn(),
  assignAgent: vi.fn(),
  remove: vi.fn(),
}));
const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  codexAccountService: () => mockService,
  logActivity: mockLogActivity,
}));

function buildApp(actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as typeof req & { actor: Record<string, unknown> }).actor = actor;
    next();
  });
  app.use("/api", codexAccountRoutes({} as never));
  app.use(errorHandler);
  return app;
}

function localBoardActor() {
  return {
    type: "board",
    source: "local_implicit",
    userId: null,
    sessionId: null,
    runId: null,
    isInstanceAdmin: true,
  };
}

describe("Codex account routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockService.list.mockResolvedValue({ accounts: [], agents: [] });
    mockService.create.mockResolvedValue({ id: accountId, companyId, name: "Pro 2" });
    mockService.startLogin.mockResolvedValue({
      status: "waiting_for_user",
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "ABCD-EFGH",
      startedAt: "2026-08-10T12:00:00.000Z",
      expiresAt: "2026-08-10T12:15:00.000Z",
      error: null,
    });
    mockService.assignAgent.mockResolvedValue({ id: agentId, codexAccountId: accountId });
    mockService.remove.mockResolvedValue(undefined);
  });

  it("lists company-scoped accounts for the board", async () => {
    const response = await request(buildApp(localBoardActor()))
      .get(`/api/companies/${companyId}/codex-accounts`)
      .expect(200);

    expect(response.body).toEqual({ accounts: [], agents: [] });
    expect(mockService.list).toHaveBeenCalledWith(companyId);
  });

  it("starts device login without writing the one-time code to the audit log", async () => {
    const response = await request(buildApp(localBoardActor()))
      .post(`/api/companies/${companyId}/codex-accounts/${accountId}/login`)
      .send({})
      .expect(200);

    expect(response.body.userCode).toBe("ABCD-EFGH");
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId,
        action: "codex_account.login_started",
        entityId: accountId,
        details: { status: "waiting_for_user" },
      }),
    );
    expect(JSON.stringify(mockLogActivity.mock.calls)).not.toContain("ABCD-EFGH");
  });

  it("updates an agent assignment and audits only the account identifier", async () => {
    await request(buildApp(localBoardActor()))
      .put(`/api/companies/${companyId}/codex-accounts/agents/${agentId}`)
      .send({ accountId })
      .expect(200);

    expect(mockService.assignAgent).toHaveBeenCalledWith(
      companyId,
      agentId,
      accountId,
      expect.objectContaining({ actorType: "user" }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "codex_account.agent_assignment_updated",
        entityId: agentId,
        details: { codexAccountId: accountId },
      }),
    );
  });

  it("denies a signed-in board member outside the company", async () => {
    const actor = {
      type: "board",
      source: "session",
      userId: "user-2",
      sessionId: "session-2",
      companyIds: ["44444444-4444-4444-8444-444444444444"],
      memberships: [],
      isInstanceAdmin: false,
    };
    await request(buildApp(actor))
      .get(`/api/companies/${companyId}/codex-accounts`)
      .expect(403);
    expect(mockService.list).not.toHaveBeenCalled();
  });
});
