export const MANAGED_ACCOUNT_SESSION_LIMIT = 2;
export const GLOBAL_LLM_SESSION_LIMIT_ENV = "PAPERCLIP_GLOBAL_LLM_SESSION_LIMIT";
export const DEFAULT_GLOBAL_LLM_SESSION_LIMIT = 4;

export function resolveGlobalLlmSessionLimit(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = (env[GLOBAL_LLM_SESSION_LIMIT_ENV] ?? "").trim();
  if (!/^\d+$/.test(raw)) return DEFAULT_GLOBAL_LLM_SESSION_LIMIT;
  const parsed = Number.parseInt(raw, 10);
  return parsed >= 1 && parsed <= 64 ? parsed : DEFAULT_GLOBAL_LLM_SESSION_LIMIT;
}

export const GLOBAL_LLM_SESSION_LIMIT = resolveGlobalLlmSessionLimit();
export const PR_GOVERNANCE_AGENT_IDS_ENV = "PAPERCLIP_PR_GOVERNANCE_AGENT_IDS";
export const PR_GOVERNANCE_RESERVED_SLOTS_ENV = "PAPERCLIP_PR_GOVERNANCE_RESERVED_SLOTS";

export type PrGovernanceReservationPolicy = {
  agentIds: string[];
  reservedSlots: number;
};

export type LlmSessionAdmission = {
  allowed: boolean;
  reason: "available" | "global_capacity" | "pr_governance_reservation";
  reservedSlotsNeeded: number;
};

export function remainingSessionSlots(limit: number, runningSessions: number): number {
  const normalizedLimit = Number.isInteger(limit) ? Math.max(0, limit) : 0;
  const normalizedRunning = Number.isFinite(runningSessions)
    ? Math.max(0, Math.floor(runningSessions))
    : normalizedLimit;
  return Math.max(0, normalizedLimit - normalizedRunning);
}

export function resolvePrGovernanceReservationPolicy(
  env: Record<string, string | undefined> = process.env,
  globalLimit = GLOBAL_LLM_SESSION_LIMIT,
): PrGovernanceReservationPolicy {
  const agentIds = [...new Set(
    (env[PR_GOVERNANCE_AGENT_IDS_ENV] ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  )];
  const rawReservedSlots = (env[PR_GOVERNANCE_RESERVED_SLOTS_ENV] ?? "").trim();
  const parsedReservedSlots = /^\d+$/.test(rawReservedSlots)
    ? Number.parseInt(rawReservedSlots, 10)
    : 0;
  const normalizedGlobalLimit = Number.isInteger(globalLimit) ? Math.max(0, globalLimit) : 0;
  const reservedSlots = agentIds.length === 0
    ? 0
    : Math.min(normalizedGlobalLimit, agentIds.length, parsedReservedSlots);

  return { agentIds, reservedSlots };
}

export function isPrGovernanceAgent(
  policy: PrGovernanceReservationPolicy,
  agentId: string,
): boolean {
  return policy.agentIds.includes(agentId);
}

export function evaluateLlmSessionAdmission(input: {
  agentId: string;
  runningSessions: number;
  governanceRunningSessions: number;
  hasRunnableGovernanceDemand: boolean;
  policy: PrGovernanceReservationPolicy;
  globalLimit?: number;
}): LlmSessionAdmission {
  const globalLimit = input.globalLimit ?? GLOBAL_LLM_SESSION_LIMIT;
  if (remainingSessionSlots(globalLimit, input.runningSessions) <= 0) {
    return { allowed: false, reason: "global_capacity", reservedSlotsNeeded: 0 };
  }

  if (isPrGovernanceAgent(input.policy, input.agentId)) {
    return { allowed: true, reason: "available", reservedSlotsNeeded: 0 };
  }

  const reservedSlotsNeeded = input.hasRunnableGovernanceDemand
    ? Math.max(0, input.policy.reservedSlots - Math.max(0, input.governanceRunningSessions))
    : 0;
  const nonGovernanceLimit = Math.max(0, globalLimit - reservedSlotsNeeded);
  if (input.runningSessions >= nonGovernanceLimit) {
    return {
      allowed: false,
      reason: "pr_governance_reservation",
      reservedSlotsNeeded,
    };
  }

  return { allowed: true, reason: "available", reservedSlotsNeeded };
}

// Agent start locks are intentionally per-agent. Subscription capacity is a
// host-wide resource, so claims for different agents/providers need one shared
// serialization point around the final capacity check and queued->running CAS.
let globalLlmStartTail: Promise<void> = Promise.resolve();

export async function withGlobalLlmStartLock<T>(task: () => Promise<T>): Promise<T> {
  const previous = globalLlmStartTail;
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  globalLlmStartTail = previous.then(() => current, () => current);
  await previous.catch(() => undefined);
  try {
    return await task();
  } finally {
    release();
  }
}
