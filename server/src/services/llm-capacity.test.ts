import { describe, expect, it } from "vitest";
import {
  evaluateLlmSessionAdmission,
  GLOBAL_LLM_SESSION_LIMIT,
  isPrGovernanceAgent,
  MANAGED_ACCOUNT_SESSION_LIMIT,
  remainingSessionSlots,
  resolvePrGovernanceReservationPolicy,
  withGlobalLlmStartLock,
} from "./llm-capacity.js";

describe("LLM capacity policy", () => {
  it("keeps the explicit account and host limits", () => {
    expect(MANAGED_ACCOUNT_SESSION_LIMIT).toBe(2);
    expect(GLOBAL_LLM_SESSION_LIMIT).toBe(4);
    expect(remainingSessionSlots(2, 0)).toBe(2);
    expect(remainingSessionSlots(2, 1)).toBe(1);
    expect(remainingSessionSlots(2, 2)).toBe(0);
    expect(remainingSessionSlots(4, 5)).toBe(0);
  });

  it("serializes only the final claim section across providers", async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const startedGate = new Promise<void>((resolve) => { firstStarted = resolve; });

    const first = withGlobalLlmStartLock(async () => {
      order.push("codex:start");
      firstStarted();
      await firstGate;
      order.push("codex:end");
    });
    const second = withGlobalLlmStartLock(async () => {
      order.push("claude:start");
    });

    await startedGate;
    expect(order).toEqual(["codex:start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["codex:start", "codex:end", "claude:start"]);
  });

  it("keeps PR governance reservation disabled unless both env values are configured", () => {
    expect(resolvePrGovernanceReservationPolicy({})).toEqual({
      agentIds: [],
      reservedSlots: 0,
    });
    expect(resolvePrGovernanceReservationPolicy({
      PAPERCLIP_PR_GOVERNANCE_AGENT_IDS: "manager, reviewer, manager",
    })).toEqual({
      agentIds: ["manager", "reviewer"],
      reservedSlots: 0,
    });
    expect(resolvePrGovernanceReservationPolicy({
      PAPERCLIP_PR_GOVERNANCE_AGENT_IDS: "manager, reviewer",
      PAPERCLIP_PR_GOVERNANCE_RESERVED_SLOTS: "9",
    })).toEqual({
      agentIds: ["manager", "reviewer"],
      reservedSlots: 2,
    });
  });

  it("reserves the fourth host slot only while runnable PR governance demand is uncovered", () => {
    const policy = resolvePrGovernanceReservationPolicy({
      PAPERCLIP_PR_GOVERNANCE_AGENT_IDS: "manager,reviewer",
      PAPERCLIP_PR_GOVERNANCE_RESERVED_SLOTS: "1",
    });

    expect(isPrGovernanceAgent(policy, "manager")).toBe(true);
    expect(evaluateLlmSessionAdmission({
      agentId: "delivery",
      runningSessions: 3,
      governanceRunningSessions: 0,
      hasRunnableGovernanceDemand: true,
      policy,
    })).toEqual({
      allowed: false,
      reason: "pr_governance_reservation",
      reservedSlotsNeeded: 1,
    });
    expect(evaluateLlmSessionAdmission({
      agentId: "manager",
      runningSessions: 3,
      governanceRunningSessions: 0,
      hasRunnableGovernanceDemand: true,
      policy,
    }).allowed).toBe(true);
    expect(evaluateLlmSessionAdmission({
      agentId: "delivery",
      runningSessions: 3,
      governanceRunningSessions: 0,
      hasRunnableGovernanceDemand: false,
      policy,
    }).allowed).toBe(true);
    expect(evaluateLlmSessionAdmission({
      agentId: "delivery",
      runningSessions: 3,
      governanceRunningSessions: 1,
      hasRunnableGovernanceDemand: true,
      policy,
    }).allowed).toBe(true);
  });

  it("reserves only the remaining uncovered governance slots", () => {
    const policy = resolvePrGovernanceReservationPolicy({
      PAPERCLIP_PR_GOVERNANCE_AGENT_IDS: "manager,reviewer",
      PAPERCLIP_PR_GOVERNANCE_RESERVED_SLOTS: "2",
    });

    expect(evaluateLlmSessionAdmission({
      agentId: "delivery",
      runningSessions: 2,
      governanceRunningSessions: 1,
      hasRunnableGovernanceDemand: true,
      policy,
    })).toEqual({
      allowed: true,
      reason: "available",
      reservedSlotsNeeded: 1,
    });
    expect(evaluateLlmSessionAdmission({
      agentId: "delivery",
      runningSessions: 3,
      governanceRunningSessions: 1,
      hasRunnableGovernanceDemand: true,
      policy,
    }).reason).toBe("pr_governance_reservation");
  });

  it("never exceeds the global host cap, including governance claims", () => {
    const policy = resolvePrGovernanceReservationPolicy({
      PAPERCLIP_PR_GOVERNANCE_AGENT_IDS: "manager",
      PAPERCLIP_PR_GOVERNANCE_RESERVED_SLOTS: "1",
    });

    expect(evaluateLlmSessionAdmission({
      agentId: "manager",
      runningSessions: 4,
      governanceRunningSessions: 0,
      hasRunnableGovernanceDemand: true,
      policy,
    })).toEqual({
      allowed: false,
      reason: "global_capacity",
      reservedSlotsNeeded: 0,
    });
  });
});
