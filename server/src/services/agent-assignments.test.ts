import { describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { HttpError, notFound } from "../errors.js";
import {
  agentAssignmentsService,
  assignmentActivityDetails,
  runtimeConfigForAgentAssignments,
  type AgentAssignmentRecord,
  type AgentAssignmentsActor,
  type AgentAssignmentsServiceDependencies,
  type SubscriptionAccountAssignment,
  type UpdateAgentAssignmentsInput,
} from "./agent-assignments.js";

const companyId = "11111111-1111-4111-8111-111111111111";
const agentId = "22222222-2222-4222-8222-222222222222";
const codexAccountId = "33333333-3333-4333-8333-333333333333";
const claudeAccountId = "44444444-4444-4444-8444-444444444444";
const initialAssignmentVersion = "55555555-5555-4555-8555-555555555555";
const policyAssignmentVersion = "66666666-6666-4666-8666-666666666666";
const codexAssignmentVersion = "77777777-7777-4777-8777-777777777777";
const claudeAssignmentVersion = "88888888-8888-4888-8888-888888888888";
const initialUpdatedAt = new Date("2026-08-15T10:00:00.000Z");

const actor: AgentAssignmentsActor = {
  actorType: "user",
  actorId: "board-user",
  userId: "board-user",
  agentId: null,
  runId: null,
  agentApiKeyId: null,
};

interface FakeState {
  agent: AgentAssignmentRecord;
  assignmentVersion: string | null;
  accounts: {
    codex: Array<{ id: string; companyId: string }>;
    claude: Array<{ id: string; companyId: string }>;
  };
  calls: string[];
  activities: Array<Record<string, unknown>>;
}

interface FakeTransactionDb {
  state: FakeState;
}

function initialState(): FakeState {
  return {
    agent: {
      id: agentId,
      companyId,
      adapterType: "codex_local",
      adapterConfig: {
        command: "/opt/codex",
        model: "gpt-old",
        extraArgs: ["--codex-only"],
        env: {
          CODEX_HOME: "/private/codex-home",
          OPENAI_API_KEY: "secret-ref",
          SHARED_SETTING: "kept",
        },
      },
      runtimeConfig: {
        keepMe: true,
        subscriptionFailover: {
          enabled: true,
          order: ["codex_local", "claude_local"],
          models: { codex_local: "gpt-test", claude_local: "claude-test" },
        },
      },
      updatedAt: initialUpdatedAt,
      codexAccountMode: "host",
      codexAccountId: null,
      claudeAccountMode: "host",
      claudeAccountId: null,
    },
    assignmentVersion: initialAssignmentVersion,
    accounts: {
      codex: [{ id: codexAccountId, companyId }],
      claude: [{ id: claudeAccountId, companyId }],
    },
    calls: [],
    activities: [],
  };
}

function fakeHarness(options: { throwOnClaude?: boolean } = {}) {
  const controller = {
    state: initialState(),
    published: [] as Array<Record<string, unknown>>,
    coordinationCalls: [] as string[],
  };

  const db = {
    transaction: async <T>(run: (tx: FakeTransactionDb) => Promise<T>) => {
      const transaction = { state: structuredClone(controller.state) };
      const result = await run(transaction);
      controller.state = transaction.state;
      return result;
    },
  } as unknown as Db;

  const readState = (transaction: Db) => (transaction as unknown as FakeTransactionDb).state;
  const validateAssignment = (
    state: FakeState,
    provider: "codex" | "claude",
    assignment: SubscriptionAccountAssignment,
  ) => {
    if (assignment.mode === "fixed") {
      const account = state.accounts[provider].find((candidate) => (
        candidate.id === assignment.accountId && candidate.companyId === state.agent.companyId
      ));
      if (!account) throw notFound(`${provider} account not found`);
    }
  };

  const dependencies: AgentAssignmentsServiceDependencies = {
    lockAgent: async (transaction, requestedCompanyId, requestedAgentId) => {
      controller.coordinationCalls.push("lock");
      const state = readState(transaction);
      return state.agent.id === requestedAgentId && state.agent.companyId === requestedCompanyId
        ? state.agent
        : null;
    },
    getAgent: async (transaction, requestedAgentId) => {
      const state = readState(transaction);
      return state.agent.id === requestedAgentId ? state.agent : null;
    },
    getLatestAssignmentVersion: async (transaction, requestedCompanyId, requestedAgentId) => {
      controller.coordinationCalls.push("version");
      const state = readState(transaction);
      if (state.agent.id !== requestedAgentId || state.agent.companyId !== requestedCompanyId) {
        return null;
      }
      return state.assignmentVersion;
    },
    listAssignmentSnapshots: async (_transaction, requestedCompanyId) => (
      controller.state.agent.companyId === requestedCompanyId
        ? [{ agent: controller.state.agent, assignmentVersion: controller.state.assignmentVersion }]
        : []
    ),
    updateAgent: async (transaction, requestedAgentId, patch) => {
      const state = readState(transaction);
      if (state.agent.id !== requestedAgentId) throw notFound("Agent not found");
      state.calls.push("policy");
      state.agent = {
        ...state.agent,
        ...patch,
        updatedAt: new Date("2026-08-15T10:01:00.000Z"),
      };
      state.assignmentVersion = policyAssignmentVersion;
      return state.agent;
    },
    assignCodex: async (transaction, requestedCompanyId, requestedAgentId, assignment) => {
      const state = readState(transaction);
      if (state.agent.companyId !== requestedCompanyId || state.agent.id !== requestedAgentId) {
        throw notFound("Agent not found");
      }
      validateAssignment(state, "codex", assignment);
      state.calls.push("codex");
      state.agent.codexAccountMode = assignment.mode;
      state.agent.codexAccountId = assignment.mode === "fixed" ? assignment.accountId : null;
      state.assignmentVersion = codexAssignmentVersion;
      return state.agent;
    },
    assignClaude: async (transaction, requestedCompanyId, requestedAgentId, assignment) => {
      const state = readState(transaction);
      if (state.agent.companyId !== requestedCompanyId || state.agent.id !== requestedAgentId) {
        throw notFound("Agent not found");
      }
      validateAssignment(state, "claude", assignment);
      state.calls.push("claude");
      state.agent.claudeAccountMode = assignment.mode;
      state.agent.claudeAccountId = assignment.mode === "fixed" ? assignment.accountId : null;
      if (options.throwOnClaude) throw new Error("Claude assignment failed");
      state.assignmentVersion = claudeAssignmentVersion;
      return state.agent;
    },
    persistAssignmentActivity: async (
      transaction,
      requestedCompanyId,
      requestedAgentId,
      input,
      appliedProviders,
    ) => {
      const state = readState(transaction);
      state.activities.push({
        companyId: requestedCompanyId,
        agentId: requestedAgentId,
        ...assignmentActivityDetails(input, appliedProviders),
      });
      return {
        companyId: requestedCompanyId,
        payload: { agentId: requestedAgentId },
        pluginEvent: null,
      };
    },
    publishAssignmentActivity: (publication) => {
      controller.published.push(publication.payload);
    },
  };

  return {
    controller,
    service: agentAssignmentsService(db, dependencies),
  };
}

function dualInput(overrides: Partial<UpdateAgentAssignmentsInput> = {}): UpdateAgentAssignmentsInput {
  return {
    strategy: "failover",
    preferredProvider: "claude_local",
    codex: { mode: "fixed", accountId: codexAccountId },
    claude: { mode: "fixed", accountId: claudeAccountId },
    expectedAssignmentVersion: initialAssignmentVersion,
    ...overrides,
  };
}

describe("agentAssignmentsService", () => {
  it("atomically preserves both provider assignments and the preferred failover order", async () => {
    const { controller, service } = fakeHarness();

    const result = await service.update(companyId, agentId, dualInput(), actor);

    expect(result).toMatchObject({
      assignmentVersion: claudeAssignmentVersion,
      agent: {
        adapterType: "codex_local",
        codexAccountMode: "fixed",
        codexAccountId,
        claudeAccountMode: "fixed",
        claudeAccountId,
      },
    });
    expect(controller.state.agent.runtimeConfig).toEqual({
      keepMe: true,
      subscriptionFailover: {
        enabled: true,
        order: ["claude_local", "codex_local"],
        models: { codex_local: "gpt-test", claude_local: "claude-test" },
      },
    });
    expect(controller.state.calls).toEqual(["policy", "codex", "claude"]);
    expect(controller.state.activities).toHaveLength(1);
    expect(controller.published).toEqual([{ agentId }]);
  });

  it("uses only the preferred provider in single mode without erasing the dormant assignment", async () => {
    const { controller, service } = fakeHarness();
    controller.state.agent.codexAccountMode = "fixed";
    controller.state.agent.codexAccountId = codexAccountId;

    const result = await service.update(companyId, agentId, dualInput({
      strategy: "single",
      preferredProvider: "claude_local",
    }), actor);

    expect(result.assignmentVersion).toBe(claudeAssignmentVersion);
    expect(result.agent.adapterType).toBe("claude_local");
    expect(result.agent.runtimeConfig).toEqual({ keepMe: true });
    expect(result.agent.adapterConfig).toEqual({
      model: "claude-test",
      env: { SHARED_SETTING: "kept" },
    });
    expect(result.agent.adapterConfig).not.toHaveProperty("command");
    expect(result.agent.adapterConfig).not.toHaveProperty("extraArgs");
    expect(result.agent.codexAccountId).toBe(codexAccountId);
    expect(result.agent.claudeAccountId).toBe(claudeAccountId);
    expect(controller.state.calls).toEqual(["policy", "claude"]);
    expect(controller.state.activities).toEqual([{
      companyId,
      agentId,
      strategy: "single",
      preferredProvider: "claude_local",
      appliedProviders: ["claude_local"],
      claudeAccountMode: "fixed",
      claudeAccountId,
    }]);
  });

  it("rolls back the policy and first provider when the second assignment fails", async () => {
    const { controller, service } = fakeHarness({ throwOnClaude: true });
    const before = structuredClone(controller.state);

    await expect(service.update(companyId, agentId, dualInput(), actor))
      .rejects.toThrow("Claude assignment failed");

    expect(controller.state).toEqual(before);
    expect(controller.published).toEqual([]);
  });

  it("rejects a stale assignment version before making any change", async () => {
    const { controller, service } = fakeHarness();

    const update = service.update(companyId, agentId, dualInput({
      expectedAssignmentVersion: "99999999-9999-4999-8999-999999999999",
    }), actor);

    await expect(update).rejects.toMatchObject({
      status: 409,
      details: {
        code: "agent_assignment_version_conflict",
        expectedAssignmentVersion: "99999999-9999-4999-8999-999999999999",
        actualAssignmentVersion: initialAssignmentVersion,
      },
    });
    expect(controller.state.calls).toEqual([]);
    expect(controller.coordinationCalls).toEqual(["lock", "version"]);
    expect(controller.state.activities).toEqual([]);
    expect(controller.published).toEqual([]);
  });

  it("does not conflict when heartbeat updates updatedAt without changing the assignment version", async () => {
    const { controller, service } = fakeHarness();
    controller.state.agent.updatedAt = new Date("2026-08-15T11:30:00.000Z");

    const result = await service.update(companyId, agentId, dualInput(), actor);

    expect(result.assignmentVersion).toBe(claudeAssignmentVersion);
    expect(controller.state.calls).toEqual(["policy", "codex", "claude"]);
  });

  it("uses null as the initial version only when the agent has no config revision", async () => {
    const { controller, service } = fakeHarness();
    controller.state.assignmentVersion = null;

    const result = await service.update(companyId, agentId, dualInput({
      expectedAssignmentVersion: null,
    }), actor);

    expect(result.assignmentVersion).toBe(claudeAssignmentVersion);
  });

  it("rejects process and other adapters instead of converting them silently", async () => {
    const { controller, service } = fakeHarness();
    controller.state.agent.adapterType = "process";
    const before = structuredClone(controller.state);

    await expect(service.update(companyId, agentId, dualInput(), actor)).rejects.toMatchObject({
      status: 422,
      details: {
        code: "unsupported_agent_adapter",
        adapterType: "process",
      },
    });

    expect(controller.state).toEqual(before);
    expect(controller.published).toEqual([]);
  });

  it("lists the agent snapshot together with the opaque version used to update it", async () => {
    const { controller, service } = fakeHarness();

    await expect(service.list(companyId)).resolves.toEqual([{
      agent: controller.state.agent,
      assignmentVersion: initialAssignmentVersion,
    }]);
  });

  it("rejects an account from another company and rolls the entire update back", async () => {
    const { controller, service } = fakeHarness();
    controller.state.accounts.claude[0]!.companyId = "99999999-9999-4999-8999-999999999999";
    const before = structuredClone(controller.state);

    await expect(service.update(companyId, agentId, dualInput(), actor))
      .rejects.toMatchObject({ status: 404 } satisfies Partial<HttpError>);

    expect(controller.state).toEqual(before);
    expect(controller.published).toEqual([]);
  });

  it("does not disclose an agent that belongs to another company", async () => {
    const { controller, service } = fakeHarness();
    const foreignCompanyId = "99999999-9999-4999-8999-999999999999";

    await expect(service.update(foreignCompanyId, agentId, dualInput(), actor))
      .rejects.toMatchObject({
        status: 404,
        message: "Agent not found",
      } satisfies Partial<HttpError>);

    expect(controller.state.calls).toEqual([]);
  });
});

describe("runtimeConfigForAgentAssignments", () => {
  it("preserves provider-specific policy fields while changing the preferred provider", () => {
    expect(runtimeConfigForAgentAssignments({
      anotherSetting: "kept",
      subscriptionFailover: {
        enabled: true,
        order: ["codex_local", "claude_local"],
        models: { codex_local: "gpt-test" },
      },
    }, {
      strategy: "failover",
      preferredProvider: "claude_local",
    })).toEqual({
      anotherSetting: "kept",
      subscriptionFailover: {
        enabled: true,
        order: ["claude_local", "codex_local"],
        models: { codex_local: "gpt-test" },
      },
    });
  });

  it("removes the failover policy completely for a single-provider assignment", () => {
    expect(runtimeConfigForAgentAssignments({
      anotherSetting: "kept",
      subscriptionFailover: { enabled: true },
    }, {
      strategy: "single",
      preferredProvider: "codex_local",
    })).toEqual({ anotherSetting: "kept" });
  });
});
