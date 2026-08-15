import { and, asc, desc, eq, getTableColumns, ne, sql } from "drizzle-orm";
import { agentConfigRevisions, agents } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { conflict, notFound, unprocessable } from "../errors.js";
import { agentService } from "./agents.js";
import { claudeAccountService } from "./claude-accounts.js";
import { codexAccountService } from "./codex-accounts.js";
import {
  readSubscriptionFailoverConfig,
  resolveSubscriptionAdapterConfig,
  type SubscriptionFailoverConfig,
} from "./subscription-failover.js";
import {
  persistActivity,
  publishActivity,
  type ActivityPublication,
  type LogActivityInput,
} from "./activity-log.js";

export type SubscriptionProvider = "codex_local" | "claude_local";
export type SubscriptionAccountMode = "host" | "fixed" | "first_available";

export interface SubscriptionAccountAssignment {
  mode: SubscriptionAccountMode;
  accountId: string | null;
}

export interface UpdateAgentAssignmentsInput {
  strategy: "single" | "failover";
  preferredProvider: SubscriptionProvider;
  codex: SubscriptionAccountAssignment;
  claude: SubscriptionAccountAssignment;
  expectedAssignmentVersion: string | null;
}

export interface AgentAssignmentSnapshot {
  agent: AgentAssignmentRecord;
  assignmentVersion: string | null;
}

export interface UpdateAgentAssignmentsResult {
  agent: AgentAssignmentRecord;
  assignmentVersion: string | null;
}

export type AgentAssignmentsActor = Pick<
  LogActivityInput,
  "actorType" | "actorId" | "agentId" | "runId" | "agentApiKeyId"
> & { userId?: string | null };

export interface AgentAssignmentRecord {
  id: string;
  companyId: string;
  adapterType: string;
  adapterConfig: Record<string, unknown>;
  runtimeConfig: Record<string, unknown> | null;
  updatedAt: Date;
  codexAccountMode?: string | null;
  codexAccountId?: string | null;
  claudeAccountMode?: string | null;
  claudeAccountId?: string | null;
  [key: string]: unknown;
}

interface AgentAssignmentPatch {
  adapterType?: SubscriptionProvider;
  adapterConfig?: Record<string, unknown>;
  runtimeConfig: Record<string, unknown>;
}

export interface AgentAssignmentsServiceDependencies {
  lockAgent: (db: Db, companyId: string, agentId: string) => Promise<AgentAssignmentRecord | null>;
  getAgent: (db: Db, agentId: string) => Promise<AgentAssignmentRecord | null>;
  getLatestAssignmentVersion: (
    db: Db,
    companyId: string,
    agentId: string,
  ) => Promise<string | null>;
  listAssignmentSnapshots: (db: Db, companyId: string) => Promise<AgentAssignmentSnapshot[]>;
  updateAgent: (
    db: Db,
    agentId: string,
    patch: AgentAssignmentPatch,
    actor: AgentAssignmentsActor,
  ) => Promise<AgentAssignmentRecord>;
  assignCodex: (
    db: Db,
    companyId: string,
    agentId: string,
    assignment: SubscriptionAccountAssignment,
    actor: AgentAssignmentsActor,
  ) => Promise<AgentAssignmentRecord>;
  assignClaude: (
    db: Db,
    companyId: string,
    agentId: string,
    assignment: SubscriptionAccountAssignment,
    actor: AgentAssignmentsActor,
  ) => Promise<AgentAssignmentRecord>;
  persistAssignmentActivity: (
    db: Db,
    companyId: string,
    agentId: string,
    input: UpdateAgentAssignmentsInput,
    appliedProviders: SubscriptionProvider[],
    actor: AgentAssignmentsActor,
  ) => Promise<ActivityPublication>;
  publishAssignmentActivity: (publication: ActivityPublication) => void;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

function failoverOrder(preferredProvider: SubscriptionProvider): [SubscriptionProvider, SubscriptionProvider] {
  return preferredProvider === "codex_local"
    ? ["codex_local", "claude_local"]
    : ["claude_local", "codex_local"];
}

export function runtimeConfigForAgentAssignments(
  runtimeConfig: Record<string, unknown> | null,
  input: Pick<UpdateAgentAssignmentsInput, "strategy" | "preferredProvider">,
): Record<string, unknown> {
  const next = asRecord(runtimeConfig);
  if (input.strategy === "single") {
    delete next.subscriptionFailover;
    return next;
  }

  const existingPolicy = asRecord(next.subscriptionFailover);
  next.subscriptionFailover = {
    ...existingPolicy,
    enabled: true,
    order: failoverOrder(input.preferredProvider),
  };
  return next;
}

export function assignmentActivityDetails(
  input: UpdateAgentAssignmentsInput,
  appliedProviders: SubscriptionProvider[],
): Record<string, unknown> {
  const codexApplied = appliedProviders.includes("codex_local");
  const claudeApplied = appliedProviders.includes("claude_local");
  return {
    strategy: input.strategy,
    preferredProvider: input.preferredProvider,
    appliedProviders,
    ...(codexApplied ? {
      codexAccountMode: input.codex.mode,
      codexAccountId: input.codex.accountId,
    } : {}),
    ...(claudeApplied ? {
      claudeAccountMode: input.claude.mode,
      claudeAccountId: input.claude.accountId,
    } : {}),
  };
}

const defaultDependencies: AgentAssignmentsServiceDependencies = {
  lockAgent: async (db, companyId, agentId) => db
    .select()
    .from(agents)
    .where(and(eq(agents.companyId, companyId), eq(agents.id, agentId)))
    .for("update")
    .then((rows) => (rows[0] as AgentAssignmentRecord | undefined) ?? null),

  getAgent: async (db, agentId) => {
    const agent = await agentService(db).getById(agentId);
    return agent as AgentAssignmentRecord | null;
  },

  getLatestAssignmentVersion: async (db, companyId, agentId) => db
    .select({ id: agentConfigRevisions.id })
    .from(agentConfigRevisions)
    .where(and(
      eq(agentConfigRevisions.companyId, companyId),
      eq(agentConfigRevisions.agentId, agentId),
    ))
    // PostgreSQL's now() is stable for the whole transaction, so several
    // revisions written by this atomic operation can share createdAt. The ID
    // tie-breaker makes the opaque version deterministic in that case.
    .orderBy(desc(agentConfigRevisions.createdAt), desc(agentConfigRevisions.id))
    .limit(1)
    .then((rows) => rows[0]?.id ?? null),

  listAssignmentSnapshots: async (db, companyId) => {
    // Agent fields and their concurrency token must come from one PostgreSQL
    // statement. Two independent reads under READ COMMITTED can otherwise
    // return agent snapshot A together with revision token B, allowing a stale
    // form to overwrite B without triggering the optimistic-concurrency guard.
    const assignmentVersion = sql<string | null>`(
      select assignment_revision.id
      from agent_config_revisions as assignment_revision
      where assignment_revision.company_id = "agents"."company_id"
        and assignment_revision.agent_id = "agents"."id"
      order by assignment_revision.created_at desc, assignment_revision.id desc
      limit 1
    )`.as("assignment_version");
    const query = db
      .select({
        ...getTableColumns(agents),
        assignmentVersion,
      })
      .from(agents)
      .where(and(eq(agents.companyId, companyId), ne(agents.status, "terminated")))
      .orderBy(asc(agents.id));
    const rows = await query;
    return rows.map((row) => {
      const { assignmentVersion: version, ...agent } = row;
      return {
        agent: agent as AgentAssignmentRecord,
        assignmentVersion: version ?? null,
      };
    });
  },

  updateAgent: async (db, agentId, patch, actor) => {
    const updated = await agentService(db).update(agentId, patch, {
      recordRevision: {
        createdByAgentId: actor.agentId ?? null,
        createdByUserId: actor.userId ?? null,
        source: "subscription_account_assignments",
      },
    });
    if (!updated) throw notFound("Agent not found");
    return updated as AgentAssignmentRecord;
  },

  assignCodex: async (db, companyId, agentId, assignment, actor) => {
    const updated = await codexAccountService(db).assignAgent(companyId, agentId, assignment, actor);
    return updated as AgentAssignmentRecord;
  },

  assignClaude: async (db, companyId, agentId, assignment, actor) => {
    const updated = await claudeAccountService(db).assignAgent(companyId, agentId, assignment, actor);
    return updated as AgentAssignmentRecord;
  },

  persistAssignmentActivity: async (
    db,
    companyId,
    agentId,
    input,
    appliedProviders,
    actor,
  ) => {
    const { publication } = await persistActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId ?? null,
      runId: actor.runId ?? null,
      agentApiKeyId: actor.agentApiKeyId ?? null,
      action: "agent.subscription_assignments.updated",
      entityType: "agent",
      entityId: agentId,
      details: assignmentActivityDetails(input, appliedProviders),
    });
    return publication;
  },

  publishAssignmentActivity: publishActivity,
};

export function agentAssignmentsService(
  db: Db,
  dependencyOverrides: Partial<AgentAssignmentsServiceDependencies> = {},
) {
  const dependencies = { ...defaultDependencies, ...dependencyOverrides };

  return {
    list: async (companyId: string): Promise<AgentAssignmentSnapshot[]> => (
      dependencies.listAssignmentSnapshots(db, companyId)
    ),

    update: async (
      companyId: string,
      agentId: string,
      input: UpdateAgentAssignmentsInput,
      actor: AgentAssignmentsActor,
    ): Promise<UpdateAgentAssignmentsResult> => {
      let committedPublication: ActivityPublication | null = null;

      const updated = await db.transaction(async (transaction) => {
        const tx = transaction as unknown as Db;
        const current = await dependencies.lockAgent(tx, companyId, agentId);
        if (!current) throw notFound("Agent not found");

        const currentAssignmentVersion = await dependencies.getLatestAssignmentVersion(
          tx,
          companyId,
          agentId,
        );
        if (currentAssignmentVersion !== input.expectedAssignmentVersion) {
          throw conflict("Agent assignments changed since this page was loaded", {
            code: "agent_assignment_version_conflict",
            expectedAssignmentVersion: input.expectedAssignmentVersion,
            actualAssignmentVersion: currentAssignmentVersion,
          });
        }

        if (current.adapterType !== "codex_local" && current.adapterType !== "claude_local") {
          throw unprocessable(
            "Only Codex or Claude agents can use subscription account assignments",
            {
              code: "unsupported_agent_adapter",
              adapterType: current.adapterType,
            },
          );
        }

        const patch: AgentAssignmentPatch = {
          runtimeConfig: runtimeConfigForAgentAssignments(current.runtimeConfig, input),
        };
        if (input.strategy === "single") {
          patch.adapterType = input.preferredProvider;
          if (current.adapterType !== input.preferredProvider) {
            const previousFailover = readSubscriptionFailoverConfig(current.runtimeConfig);
            const temporaryFailover: SubscriptionFailoverConfig = {
              enabled: true,
              order: failoverOrder(input.preferredProvider),
              ...(previousFailover?.models ? { models: previousFailover.models } : {}),
            };
            patch.adapterConfig = resolveSubscriptionAdapterConfig({
              adapterConfig: asRecord(current.adapterConfig),
              agentAdapterType: current.adapterType,
              effectiveAdapterType: input.preferredProvider,
              failover: temporaryFailover,
            });
          }
        }
        await dependencies.updateAgent(tx, agentId, patch, actor);

        const appliedProviders: SubscriptionProvider[] = [];
        if (input.strategy === "failover") {
          // Both assignments are written in the same database transaction. If
          // either provider rejects its account, the policy and the other
          // provider's assignment roll back together.
          await dependencies.assignCodex(tx, companyId, agentId, input.codex, actor);
          appliedProviders.push("codex_local");
          await dependencies.assignClaude(tx, companyId, agentId, input.claude, actor);
          appliedProviders.push("claude_local");
        } else if (input.preferredProvider === "codex_local") {
          await dependencies.assignCodex(tx, companyId, agentId, input.codex, actor);
          appliedProviders.push("codex_local");
        } else {
          await dependencies.assignClaude(tx, companyId, agentId, input.claude, actor);
          appliedProviders.push("claude_local");
        }

        const finalAgent = await dependencies.getAgent(tx, agentId);
        if (!finalAgent || finalAgent.companyId !== companyId) throw notFound("Agent not found");

        committedPublication = await dependencies.persistAssignmentActivity(
          tx,
          companyId,
          agentId,
          input,
          appliedProviders,
          actor,
        );
        const assignmentVersion = await dependencies.getLatestAssignmentVersion(
          tx,
          companyId,
          agentId,
        );
        return { agent: finalAgent, assignmentVersion };
      });

      // Live/plugin publication is deliberately post-commit. The activity row
      // itself is persisted inside the transaction, so observers never see an
      // event for an assignment that was rolled back.
      if (committedPublication) dependencies.publishAssignmentActivity(committedPublication);
      return updated;
    },
  };
}
