/** Cross-provider Codex/Claude subscription failover helpers. */
export type SubscriptionAdapterType = "codex_local" | "claude_local";

export interface SubscriptionFailoverConfig {
  enabled: boolean;
  order: [SubscriptionAdapterType, SubscriptionAdapterType];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isSubscriptionAdapterType(value: unknown): value is SubscriptionAdapterType {
  return value === "codex_local" || value === "claude_local";
}

export function otherSubscriptionAdapter(
  adapterType: SubscriptionAdapterType,
): SubscriptionAdapterType {
  return adapterType === "codex_local" ? "claude_local" : "codex_local";
}

export function defaultSubscriptionFailoverOrder(
  primary: SubscriptionAdapterType = "codex_local",
): [SubscriptionAdapterType, SubscriptionAdapterType] {
  return [primary, otherSubscriptionAdapter(primary)];
}

/** Parse runtimeConfig.subscriptionFailover; invalid shapes return null. */
export function readSubscriptionFailoverConfig(
  runtimeConfig: unknown,
): SubscriptionFailoverConfig | null {
  const root = asRecord(runtimeConfig);
  const raw = asRecord(root?.subscriptionFailover);
  if (!raw || raw.enabled !== true) return null;
  const orderRaw = Array.isArray(raw.order) ? raw.order : null;
  if (!orderRaw || orderRaw.length < 2) {
    return {
      enabled: true,
      order: defaultSubscriptionFailoverOrder("codex_local"),
    };
  }
  const first = orderRaw[0];
  const second = orderRaw[1];
  if (!isSubscriptionAdapterType(first) || !isSubscriptionAdapterType(second) || first === second) {
    return {
      enabled: true,
      order: defaultSubscriptionFailoverOrder("codex_local"),
    };
  }
  return { enabled: true, order: [first, second] };
}

export function agentAllowsSubscriptionFailoverAssign(
  agent: { adapterType: string; runtimeConfig?: unknown },
  provider: SubscriptionAdapterType,
): boolean {
  if (agent.adapterType === provider) return true;
  const failover = readSubscriptionFailoverConfig(agent.runtimeConfig);
  if (!failover) return false;
  return failover.order.includes(provider);
}

export function resolveEffectiveSubscriptionAdapter(input: {
  agentAdapterType: string;
  runtimeConfig: unknown;
  contextSnapshot?: unknown;
}): SubscriptionAdapterType | null {
  const context = asRecord(input.contextSnapshot);
  const forced = context?.paperclipEffectiveAdapterType;
  if (isSubscriptionAdapterType(forced)) return forced;

  const failover = readSubscriptionFailoverConfig(input.runtimeConfig);
  if (failover) return failover.order[0];

  return isSubscriptionAdapterType(input.agentAdapterType) ? input.agentAdapterType : null;
}

export function nextSubscriptionFailoverAdapter(input: {
  runtimeConfig: unknown;
  currentAdapterType: string;
}): SubscriptionAdapterType | null {
  const failover = readSubscriptionFailoverConfig(input.runtimeConfig);
  if (!failover) return null;
  if (!isSubscriptionAdapterType(input.currentAdapterType)) return failover.order[1];
  const index = failover.order.indexOf(input.currentAdapterType);
  if (index < 0) return failover.order[0];
  return failover.order[(index + 1) % failover.order.length] ?? null;
}

export function withSubscriptionFailoverRetryContext(
  contextSnapshot: Record<string, unknown>,
  nextAdapter: SubscriptionAdapterType,
): Record<string, unknown> {
  return {
    ...contextSnapshot,
    paperclipEffectiveAdapterType: nextAdapter,
    paperclipSubscriptionFailover: {
      ...(asRecord(contextSnapshot.paperclipSubscriptionFailover) ?? {}),
      flippedAt: new Date().toISOString(),
      effectiveAdapterType: nextAdapter,
    },
    // Cross-provider resume is unsafe; force a fresh harness session.
    forceFreshSession: true,
  };
}
