/**
 * Cross-provider Codex/Claude subscription failover helpers.
 *
 * The active installation wires this contract into both retry scheduling and
 * provider execution. This source checkout intentionally keeps the helper
 * isolated until that complete execution overlay is ported; wiring only the
 * scheduler here would label a Claude retry that this source still executes as
 * Codex after a rebuild.
 */
export type SubscriptionAdapterType = "codex_local" | "claude_local";

export interface SubscriptionFailoverConfig {
  enabled: boolean;
  order: [SubscriptionAdapterType, SubscriptionAdapterType];
  models?: Partial<Record<SubscriptionAdapterType, string>>;
}

export interface SubscriptionFailoverRetryTiming {
  hasFailoverPolicy: boolean;
  failoverRetryAdapter: SubscriptionAdapterType | null;
  switchesProvider: boolean;
  effectiveRetryNotBefore: Date | null;
  sourceProviderRetryNotBefore: Date | null;
  targetProviderRetryNotBefore: Date | null;
  quotaNotBeforeByProvider: Partial<Record<SubscriptionAdapterType, string>>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isSubscriptionAdapterType(value: unknown): value is SubscriptionAdapterType {
  return value === "codex_local" || value === "claude_local";
}

export function otherSubscriptionAdapter(adapterType: SubscriptionAdapterType): SubscriptionAdapterType {
  return adapterType === "codex_local" ? "claude_local" : "codex_local";
}

export function defaultSubscriptionFailoverOrder(
  primary: SubscriptionAdapterType = "codex_local",
): [SubscriptionAdapterType, SubscriptionAdapterType] {
  return [primary, otherSubscriptionAdapter(primary)];
}

function readFailoverModels(raw: Record<string, unknown> | null) {
  const models = asRecord(raw?.models);
  if (!models) return undefined;
  const next: Partial<Record<SubscriptionAdapterType, string>> = {};
  for (const key of ["codex_local", "claude_local"] as const) {
    const value = models[key];
    if (typeof value === "string" && value.trim()) next[key] = value.trim();
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

function withFailoverModels(
  config: Omit<SubscriptionFailoverConfig, "models">,
  raw: Record<string, unknown>,
): SubscriptionFailoverConfig {
  const models = readFailoverModels(raw);
  return models ? { ...config, models } : config;
}

/** Parse runtimeConfig.subscriptionFailover; invalid shapes use the safe default order. */
export function readSubscriptionFailoverConfig(runtimeConfig: unknown): SubscriptionFailoverConfig | null {
  const root = asRecord(runtimeConfig);
  const raw = asRecord(root?.subscriptionFailover);
  if (!raw || raw.enabled !== true) return null;

  const orderRaw = Array.isArray(raw.order) ? raw.order : null;
  if (!orderRaw || orderRaw.length < 2) {
    return withFailoverModels({
      enabled: true,
      order: defaultSubscriptionFailoverOrder("codex_local"),
    }, raw);
  }

  const first = orderRaw[0];
  const second = orderRaw[1];
  if (!isSubscriptionAdapterType(first) || !isSubscriptionAdapterType(second) || first === second) {
    return withFailoverModels({
      enabled: true,
      order: defaultSubscriptionFailoverOrder("codex_local"),
    }, raw);
  }
  return withFailoverModels({ enabled: true, order: [first, second] }, raw);
}

export function modelForSubscriptionAdapter(
  failover: SubscriptionFailoverConfig | null,
  adapterType: string,
  adapterConfig?: Record<string, unknown> | null,
) {
  if (isSubscriptionAdapterType(adapterType)) {
    const configured = failover?.models?.[adapterType]?.trim();
    if (configured) return configured;
  }
  const fallback = adapterConfig?.model;
  return typeof fallback === "string" && fallback.trim() ? fallback.trim() : null;
}

export function agentAllowsSubscriptionFailoverAssign(
  agent: { adapterType: string; runtimeConfig?: unknown },
  provider: SubscriptionAdapterType,
) {
  if (agent.adapterType === provider) return true;
  const failover = readSubscriptionFailoverConfig(agent.runtimeConfig);
  return failover ? failover.order.includes(provider) : false;
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

function readQuotaNotBeforeByProvider(contextSnapshot: unknown) {
  const context = asRecord(contextSnapshot);
  const failover = asRecord(context?.paperclipSubscriptionFailover);
  const rawMap = asRecord(failover?.quotaNotBeforeByProvider);
  const result: Partial<Record<SubscriptionAdapterType, string>> = {};
  for (const provider of ["codex_local", "claude_local"] as const) {
    const raw = rawMap?.[provider];
    if (!(typeof raw === "string" || typeof raw === "number" || raw instanceof Date)) continue;
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) result[provider] = parsed.toISOString();
  }
  return result;
}

export function resolveSubscriptionFailoverRetryTiming(input: {
  runtimeConfig: unknown;
  currentAdapterType: string;
  retryNotBefore: Date | null;
  contextSnapshot?: unknown;
}): SubscriptionFailoverRetryTiming {
  const alternateAdapter = nextSubscriptionFailoverAdapter(input);
  const quotaNotBeforeByProvider = readQuotaNotBeforeByProvider(input.contextSnapshot);
  if (isSubscriptionAdapterType(input.currentAdapterType) && input.retryNotBefore) {
    quotaNotBeforeByProvider[input.currentAdapterType] = input.retryNotBefore.toISOString();
  }
  if (!isSubscriptionAdapterType(input.currentAdapterType) || !alternateAdapter) {
    return {
      hasFailoverPolicy: false,
      failoverRetryAdapter: null,
      switchesProvider: false,
      effectiveRetryNotBefore: input.retryNotBefore,
      sourceProviderRetryNotBefore: null,
      targetProviderRetryNotBefore: null,
      quotaNotBeforeByProvider,
    };
  }

  const currentRetryNotBeforeValue = quotaNotBeforeByProvider[input.currentAdapterType];
  const alternateRetryNotBeforeValue = quotaNotBeforeByProvider[alternateAdapter];
  const shouldStayOnCurrent = Boolean(
    currentRetryNotBeforeValue &&
    alternateRetryNotBeforeValue &&
    new Date(currentRetryNotBeforeValue).getTime() <= new Date(alternateRetryNotBeforeValue).getTime(),
  );
  const selectedAdapter = shouldStayOnCurrent ? input.currentAdapterType : alternateAdapter;
  const switchesProvider = selectedAdapter !== input.currentAdapterType;
  const targetRetryNotBeforeValue = quotaNotBeforeByProvider[selectedAdapter];
  const targetProviderRetryNotBefore = targetRetryNotBeforeValue
    ? new Date(targetRetryNotBeforeValue)
    : null;
  return {
    hasFailoverPolicy: true,
    failoverRetryAdapter: switchesProvider ? selectedAdapter : null,
    switchesProvider,
    effectiveRetryNotBefore: targetProviderRetryNotBefore,
    sourceProviderRetryNotBefore: switchesProvider ? input.retryNotBefore : null,
    targetProviderRetryNotBefore,
    quotaNotBeforeByProvider,
  };
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
