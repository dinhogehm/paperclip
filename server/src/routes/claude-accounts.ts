import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { validate } from "../middleware/validate.js";
import { claudeAccountService, logActivity } from "../services/index.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";

const createClaudeAccountSchema = z.object({ name: z.string().trim().min(1).max(80) });

const assignClaudeAccountSchema = z.object({
  mode: z.enum(["host", "fixed", "first_available"]).optional(),
  accountId: z.string().uuid().nullable().optional(),
}).transform((value) => {
  const mode = value.mode ?? (value.accountId ? "fixed" : "host");
  return { mode, accountId: mode === "fixed" ? value.accountId ?? null : null };
}).refine((value) => value.mode !== "fixed" || value.accountId !== null, {
  message: "A fixed Claude account requires accountId",
  path: ["accountId"],
});

export function claudeAccountRoutes(db: Db) {
  const router = Router();
  const service = claudeAccountService(db);
  const assertAccess = (req: Parameters<typeof assertBoard>[0], companyId: string) => {
    assertCompanyAccess(req, companyId);
    assertBoard(req);
  };

  router.get("/companies/:companyId/claude-accounts", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertAccess(req, companyId);
    res.json(await service.list(companyId));
  });

  router.post("/companies/:companyId/claude-accounts", validate(createClaudeAccountSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertAccess(req, companyId);
    const account = await service.create(companyId, req.body.name);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "claude_account.created",
      entityType: "claude_account",
      entityId: account.id,
      details: { name: account.name },
    });
    res.status(201).json(account);
  });

  router.post("/companies/:companyId/claude-accounts/:accountId/login", async (req, res) => {
    const companyId = req.params.companyId as string;
    const accountId = req.params.accountId as string;
    assertAccess(req, companyId);
    const login = await service.startLogin(companyId, accountId);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "claude_account.login_started",
      entityType: "claude_account",
      entityId: accountId,
      details: { status: login.status },
    });
    res.json(login);
  });

  router.put(
    "/companies/:companyId/claude-accounts/agents/:agentId",
    validate(assignClaudeAccountSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const agentId = req.params.agentId as string;
      assertAccess(req, companyId);
      const actor = getActorInfo(req);
      const assignment = { mode: req.body.mode, accountId: req.body.accountId };
      const agent = await service.assignAgent(companyId, agentId, assignment, actor);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        action: "claude_account.agent_assignment_updated",
        entityType: "agent",
        entityId: agentId,
        details: { claudeAccountMode: assignment.mode, claudeAccountId: assignment.accountId },
      });
      res.json(agent);
    },
  );

  router.delete("/companies/:companyId/claude-accounts/:accountId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const accountId = req.params.accountId as string;
    assertAccess(req, companyId);
    await service.remove(companyId, accountId);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "claude_account.deleted",
      entityType: "claude_account",
      entityId: accountId,
    });
    res.status(204).send();
  });

  return router;
}
