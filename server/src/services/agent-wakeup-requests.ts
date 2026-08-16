import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentWakeupRequests } from "@paperclipai/db";
import {
  logActivity,
  publishActivity,
  type ActivityPublication,
  type LogActivityInput,
} from "./activity-log.js";

const CANCELLABLE_WAKEUP_REQUEST_STATUSES = ["queued", "deferred_issue_execution"] as const;

type AgentWakeupRequest = typeof agentWakeupRequests.$inferSelect;
type CancellableWakeupRequestStatus = (typeof CANCELLABLE_WAKEUP_REQUEST_STATUSES)[number];
type ActivityLogger = (
  db: Db,
  input: LogActivityInput,
  postCommitPublications?: ActivityPublication[],
) => Promise<unknown>;

export type AgentWakeupRequestCancellationActor = Pick<
  LogActivityInput,
  "actorType" | "actorId"
>;

export type AgentWakeupRequestServiceOptions = {
  activityLogger?: ActivityLogger;
  activityPublisher?: (publication: ActivityPublication) => void;
};

export type CancelAgentWakeupRequestResult =
  | {
    outcome: "cancelled";
    previousStatus: CancellableWakeupRequestStatus;
    wakeupRequest: AgentWakeupRequest;
  }
  | {
    outcome: "already_cancelled";
    wakeupRequest: AgentWakeupRequest;
  }
  | {
    outcome: "conflict";
    reason: "claimed_or_run_bound" | "status_not_cancellable" | "concurrent_update";
    wakeupRequest: AgentWakeupRequest;
  };

function isCancellableStatus(status: string): status is CancellableWakeupRequestStatus {
  return CANCELLABLE_WAKEUP_REQUEST_STATUSES.some((candidate) => candidate === status);
}

export function agentWakeupRequestService(
  db: Db,
  options: AgentWakeupRequestServiceOptions = {},
) {
  const activityLogger = options.activityLogger ?? logActivity;
  const activityPublisher = options.activityPublisher ?? publishActivity;

  async function getById(id: string) {
    return db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, id))
      .then((rows) => rows[0] ?? null);
  }

  async function getByIdForCompany(txDb: Db, id: string, companyId: string) {
    return txDb
      .select()
      .from(agentWakeupRequests)
      .where(and(
        eq(agentWakeupRequests.id, id),
        eq(agentWakeupRequests.companyId, companyId),
      ))
      .then((rows) => rows[0] ?? null);
  }

  async function cancelWithDb(
    txDb: Db,
    id: string,
    companyId: string,
    reason: string,
  ): Promise<CancelAgentWakeupRequestResult | null> {
    let wakeupRequest = await getByIdForCompany(txDb, id, companyId);
    if (!wakeupRequest) return null;

    // A bounded retry handles a worker claim or a concurrent cancellation that
    // wins between the read and the compare-and-set update.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (wakeupRequest.status === "cancelled") {
        return { outcome: "already_cancelled", wakeupRequest };
      }
      if (wakeupRequest.status === "claimed" || wakeupRequest.runId !== null) {
        return {
          outcome: "conflict",
          reason: "claimed_or_run_bound",
          wakeupRequest,
        };
      }
      if (!isCancellableStatus(wakeupRequest.status)) {
        return {
          outcome: "conflict",
          reason: "status_not_cancellable",
          wakeupRequest,
        };
      }

      const previousStatus = wakeupRequest.status;
      const now = new Date();
      const cancelled = await txDb
        .update(agentWakeupRequests)
        .set({
          status: "cancelled",
          finishedAt: now,
          error: reason,
          updatedAt: now,
        })
        .where(and(
          eq(agentWakeupRequests.id, id),
          eq(agentWakeupRequests.companyId, companyId),
          eq(agentWakeupRequests.status, previousStatus),
          isNull(agentWakeupRequests.runId),
        ))
        .returning()
        .then((rows) => rows[0] ?? null);

      if (cancelled) {
        return {
          outcome: "cancelled",
          previousStatus,
          wakeupRequest: cancelled,
        };
      }

      const current = await getByIdForCompany(txDb, id, companyId);
      if (!current) return null;
      wakeupRequest = current;
    }

    return {
      outcome: "conflict",
      reason: "concurrent_update",
      wakeupRequest,
    };
  }

  async function cancel(
    id: string,
    companyId: string,
    reason: string,
    actor: AgentWakeupRequestCancellationActor,
  ): Promise<CancelAgentWakeupRequestResult | null> {
    const postCommitPublications: ActivityPublication[] = [];
    const result = await db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      const cancellation = await cancelWithDb(txDb, id, companyId, reason);
      if (cancellation?.outcome === "cancelled") {
        await activityLogger(txDb, {
          companyId: cancellation.wakeupRequest.companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: cancellation.wakeupRequest.agentId,
          action: "agent_wakeup_request.cancelled",
          entityType: "agent_wakeup_request",
          entityId: cancellation.wakeupRequest.id,
          details: {
            previousStatus: cancellation.previousStatus,
            reason,
          },
        }, postCommitPublications);
      }
      return cancellation;
    });

    for (const publication of postCommitPublications) {
      activityPublisher(publication);
    }
    return result;
  }

  return {
    getById,
    cancel,
  };
}
