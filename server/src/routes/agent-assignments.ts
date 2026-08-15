import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { validate } from "../middleware/validate.js";
import { agentAssignmentsService } from "../services/agent-assignments.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";

const subscriptionAccountAssignmentSchema = z.object({
  mode: z.enum(["host", "fixed", "first_available"]),
  accountId: z.string().uuid().nullable(),
}).strict().superRefine((assignment, context) => {
  if (assignment.mode === "fixed" && assignment.accountId === null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "A fixed account assignment requires accountId",
      path: ["accountId"],
    });
  }
  if (assignment.mode !== "fixed" && assignment.accountId !== null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "accountId must be null unless mode is fixed",
      path: ["accountId"],
    });
  }
});

export const updateAgentAssignmentsSchema = z.object({
  strategy: z.enum(["single", "failover"]),
  preferredProvider: z.enum(["codex_local", "claude_local"]),
  codex: subscriptionAccountAssignmentSchema,
  claude: subscriptionAccountAssignmentSchema,
  expectedAssignmentVersion: z.string().uuid().nullable(),
}).strict();

export function agentAssignmentRoutes(db: Db) {
  const router = Router();
  const service = agentAssignmentsService(db);

  router.get(
    "/companies/:companyId/agent-assignments",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      assertBoard(req);

      const assignments = await service.list(companyId);
      res.json({ assignments });
    },
  );

  router.put(
    "/companies/:companyId/agent-assignments/:agentId",
    validate(updateAgentAssignmentsSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const agentId = req.params.agentId as string;
      assertCompanyAccess(req, companyId);
      assertBoard(req);

      const actor = getActorInfo(req);
      const result = await service.update(companyId, agentId, req.body, {
        ...actor,
        userId: actor.actorType === "user" ? actor.actorId : null,
      });
      res.json(result);
    },
  );

  return router;
}
