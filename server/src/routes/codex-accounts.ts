import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { validate } from "../middleware/validate.js";
import { codexAccountService, logActivity } from "../services/index.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";

const createCodexAccountSchema = z.object({
  name: z.string().trim().min(1).max(80),
});

const assignCodexAccountSchema = z.object({
  accountId: z.string().uuid().nullable(),
});

export function codexAccountRoutes(db: Db) {
  const router = Router();
  const service = codexAccountService(db);

  function assertAccountSettingsAccess(req: Parameters<typeof assertBoard>[0], companyId: string) {
    assertCompanyAccess(req, companyId);
    assertBoard(req);
  }

  router.get("/companies/:companyId/codex-accounts", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertAccountSettingsAccess(req, companyId);
    res.json(await service.list(companyId));
  });

  router.post(
    "/companies/:companyId/codex-accounts",
    validate(createCodexAccountSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertAccountSettingsAccess(req, companyId);
      const account = await service.create(companyId, req.body.name);
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        action: "codex_account.created",
        entityType: "codex_account",
        entityId: account.id,
        details: { name: account.name },
      });
      res.status(201).json(account);
    },
  );

  router.post("/companies/:companyId/codex-accounts/:accountId/login", async (req, res) => {
    const companyId = req.params.companyId as string;
    const accountId = req.params.accountId as string;
    assertAccountSettingsAccess(req, companyId);
    const login = await service.startLogin(companyId, accountId);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "codex_account.login_started",
      entityType: "codex_account",
      entityId: accountId,
      details: { status: login.status },
    });
    res.json(login);
  });

  router.put(
    "/companies/:companyId/codex-accounts/agents/:agentId",
    validate(assignCodexAccountSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const agentId = req.params.agentId as string;
      assertAccountSettingsAccess(req, companyId);
      const actor = getActorInfo(req);
      const agent = await service.assignAgent(companyId, agentId, req.body.accountId, actor);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        action: "codex_account.agent_assignment_updated",
        entityType: "agent",
        entityId: agentId,
        details: { codexAccountId: req.body.accountId },
      });
      res.json(agent);
    },
  );

  router.delete("/companies/:companyId/codex-accounts/:accountId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const accountId = req.params.accountId as string;
    assertAccountSettingsAccess(req, companyId);
    await service.remove(companyId, accountId);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "codex_account.removed",
      entityType: "codex_account",
      entityId: accountId,
    });
    res.status(204).end();
  });

  return router;
}
