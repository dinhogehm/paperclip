import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { claudeAccountRoutes } from "../routes/claude-accounts.js";

const companyId = "11111111-1111-4111-8111-111111111111";
const accountId = "22222222-2222-4222-8222-222222222222";
const agentId = "33333333-3333-4333-8333-333333333333";
const mockService = vi.hoisted(() => ({
  list: vi.fn(), create: vi.fn(), startLogin: vi.fn(), assignAgent: vi.fn(), remove: vi.fn(),
}));
const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  claudeAccountService: () => mockService,
  logActivity: mockLogActivity,
}));

function app() {
  const instance = express();
  instance.use(express.json());
  instance.use((req, _res, next) => {
    (req as typeof req & { actor: Record<string, unknown> }).actor = {
      type: "board", source: "local_implicit", userId: null, sessionId: null, runId: null, isInstanceAdmin: true,
    };
    next();
  });
  instance.use("/api", claudeAccountRoutes({} as never));
  instance.use(errorHandler);
  return instance;
}

describe("Claude account routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockService.list.mockResolvedValue({ accounts: [], agents: [] });
    mockService.create.mockResolvedValue({ id: accountId, companyId, name: "Max 2" });
    mockService.startLogin.mockResolvedValue({
      status: "waiting_for_user", verificationUrl: "https://claude.ai/login", startedAt: null, expiresAt: null, error: null,
    });
    mockService.assignAgent.mockResolvedValue({ id: agentId });
  });

  it("lists company-scoped profiles", async () => {
    await request(app()).get(`/api/companies/${companyId}/claude-accounts`).expect(200);
    expect(mockService.list).toHaveBeenCalledWith(companyId);
  });

  it("starts login without persisting the provider URL in activity", async () => {
    await request(app()).post(`/api/companies/${companyId}/claude-accounts/${accountId}/login`).send({}).expect(200);
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "claude_account.login_started", details: { status: "waiting_for_user" },
    }));
    expect(JSON.stringify(mockLogActivity.mock.calls)).not.toContain("claude.ai/login");
  });

  it("accepts automatic first-available selection", async () => {
    await request(app()).put(`/api/companies/${companyId}/claude-accounts/agents/${agentId}`)
      .send({ mode: "first_available", accountId: null }).expect(200);
    expect(mockService.assignAgent).toHaveBeenCalledWith(
      companyId,
      agentId,
      { mode: "first_available", accountId: null },
      expect.objectContaining({ actorType: "user" }),
    );
  });
});
