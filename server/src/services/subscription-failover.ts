/** Cross-provider Codex/Claude subscription failover helpers. */
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

const CROSS_PROVIDER_CONFIG_KEYS = [
  "cwd",
  "instructionsFilePath",
  "promptTemplate",
  "env",
  "workspaceStrategy",
  "workspaceRuntime",
  "filesystemScope",
  "filesystemExtraPaths",
  "filesystemSandboxCommand",
  "networkScope",
  "networkAllowlist",
  "timeoutSec",
  "graceSec",
] as const;

const PROVIDER_SPECIFIC_ENV_KEYS = new Set([
  "CODEX_HOME",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_SECURESTORAGE_CONFIG_DIR",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
]);

const PROVIDER_SPECIFIC_ENV_PREFIXES = [
  "OPENAI_",
  "CODEX_",
  "ANTHROPIC_",
  "CLAUDE_",
  "AZURE_OPENAI_",
] as const;

const PROVIDER_ENV_PREFIXES: Record<SubscriptionAdapterType, readonly string[]> = {
  codex_local: ["OPENAI_", "CODEX_", "AZURE_OPENAI_"],
  claude_local: ["ANTHROPIC_", "CLAUDE_"],
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function isSubscriptionAdapterType(value: unknown): value is SubscriptionAdapterType {
  return value === "codex_local" || value === "claude_local";
}

export function otherSubscriptionAdapter(adapterType: SubscriptionAdapterType): SubscriptionAdapterType {
  return adapterType === "codex_local" ? "claude_local" : "codex_local";
}

/**
 * Remove credentials and routing flags owned by either subscription provider.
 *
 * Cross-provider adapter config is sanitized before workspace/env resolution,
 * but project, routine, environment, and secret bindings are merged later. A
 * second pass over the fully resolved env prevents those later sources from
 * reintroducing the primary provider's credentials into the fallback process.
 */
export function stripSubscriptionProviderSpecificEnv(value: unknown): Record<string, unknown> {
  const sourceEnv = asRecord(value);
  if (!sourceEnv) return {};
  return Object.fromEntries(
    Object.entries(sourceEnv).filter(([envKey]) =>
      !PROVIDER_SPECIFIC_ENV_KEYS.has(envKey)
      && !PROVIDER_SPECIFIC_ENV_PREFIXES.some((prefix) => envKey.startsWith(prefix))
    ),
  );
}

/**
 * Apply the post-resolution env isolation pass only during a cross-provider
 * run. Same-provider runs retain their established project/routine env
 * semantics; the selected managed-account env is reapplied by the caller.
 */
export function sanitizeResolvedSubscriptionAdapterConfig(input: {
  adapterConfig: Record<string, unknown>;
  agentAdapterType: string;
  effectiveAdapterType: string;
}): Record<string, unknown> {
  if (
    !isSubscriptionAdapterType(input.agentAdapterType)
    || !isSubscriptionAdapterType(input.effectiveAdapterType)
    || input.agentAdapterType === input.effectiveAdapterType
  ) {
    return { ...input.adapterConfig };
  }

  const sanitized = { ...input.adapterConfig };
  if (asRecord(input.adapterConfig.env)) {
    sanitized.env = stripSubscriptionProviderSpecificEnv(input.adapterConfig.env);
  }
  return sanitized;
}

/**
 * Override ambient credentials owned by the inactive subscription provider.
 *
 * Local adapters merge their config env over process.env. Deleting a primary
 * provider key from adapterConfig is therefore insufficient during failover:
 * the key can otherwise reappear from the Paperclip server environment. Empty
 * overrides keep the effective provider's host environment available while
 * preventing the inactive provider's credentials from reaching the child.
 */
export function resolveCrossProviderProcessEnvOverrides(input: {
  processEnv: Record<string, string | undefined>;
  agentAdapterType: string;
  effectiveAdapterType: string;
}): Record<string, string> {
  if (
    !isSubscriptionAdapterType(input.agentAdapterType)
    || !isSubscriptionAdapterType(input.effectiveAdapterType)
    || input.agentAdapterType === input.effectiveAdapterType
  ) {
    return {};
  }

  const inactiveProvider = otherSubscriptionAdapter(input.effectiveAdapterType);
  const inactivePrefixes = PROVIDER_ENV_PREFIXES[inactiveProvider];
  return Object.fromEntries(
    Object.keys(input.processEnv)
      .filter((envKey) => inactivePrefixes.some((prefix) => envKey.startsWith(prefix)))
      .map((envKey) => [envKey, ""]),
  );
}

/**
 * Capacity is transient and may change independently for each provider. Drop
 * the previous account reservation, and when failover is enabled also drop the
 * provider pin so the retry evaluates the full configured order again. Quota
 * deadlines remain in the nested failover metadata and continue to guide
 * subsequent quota retries.
 */
export function resetSubscriptionProviderSelectionForCapacityRetry(
  contextSnapshot: Record<string, unknown>,
  hasFailoverPolicy: boolean,
): Record<string, unknown> {
  const next = { ...contextSnapshot };
  delete next.paperclipCodexAccount;
  delete next.paperclipClaudeAccount;
  if (!hasFailoverPolicy) return next;

  delete next.paperclipEffectiveAdapterType;
  const existingFailoverMetadata = asRecord(next.paperclipSubscriptionFailover);
  const failoverMetadata = existingFailoverMetadata ? { ...existingFailoverMetadata } : {};
  delete failoverMetadata.effectiveAdapterType;
  if (Object.keys(failoverMetadata).length > 0) {
    next.paperclipSubscriptionFailover = failoverMetadata;
  } else {
    delete next.paperclipSubscriptionFailover;
  }
  return next;
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

/** Parse runtimeConfig.subscriptionFailover; invalid legacy shapes fail closed. */
export function readSubscriptionFailoverConfig(runtimeConfig: unknown): SubscriptionFailoverConfig | null {
  const root = asRecord(runtimeConfig);
  const raw = asRecord(root?.subscriptionFailover);
  if (!raw || raw.enabled !== true) return null;

  const orderRaw = Array.isArray(raw.order) ? raw.order : null;
  if (!orderRaw || orderRaw.length !== 2) return null;

  const first = orderRaw[0];
  const second = orderRaw[1];
  if (!isSubscriptionAdapterType(first) || !isSubscriptionAdapterType(second) || first === second) {
    return null;
  }
  return withFailoverModels({ enabled: true, order: [first, second] }, raw);
}

/**
 * Build the adapter config for the provider that will actually execute.
 *
 * The agent's persisted adapterConfig belongs to agent.adapterType. Reusing
 * provider-specific command/model flags across providers is unsafe, so a
 * fallback provider receives only the shared execution fields plus its own
 * optional model. Adapter defaults fill the remaining provider-specific
 * values.
 */
export function resolveSubscriptionAdapterConfig(input: {
  adapterConfig: Record<string, unknown>;
  agentAdapterType: string;
  effectiveAdapterType: string;
  failover: SubscriptionFailoverConfig | null;
}): Record<string, unknown> {
  if (!input.failover || !isSubscriptionAdapterType(input.effectiveAdapterType)) {
    return { ...input.adapterConfig };
  }

  if (input.effectiveAdapterType === input.agentAdapterType) {
    const primary = { ...input.adapterConfig };
    const configuredModel = input.failover.models?.[input.effectiveAdapterType];
    if (configuredModel) primary.model = configuredModel;
    return primary;
  }

  const fallback: Record<string, unknown> = {};
  for (const key of CROSS_PROVIDER_CONFIG_KEYS) {
    if (Object.prototype.hasOwnProperty.call(input.adapterConfig, key)) {
      if (key !== "env") {
        fallback[key] = input.adapterConfig[key];
        continue;
      }
      if (!asRecord(input.adapterConfig.env)) continue;
      fallback.env = stripSubscriptionProviderSpecificEnv(input.adapterConfig.env);
    }
  }
  const configuredModel = input.failover.models?.[input.effectiveAdapterType];
  if (configuredModel) fallback.model = configuredModel;
  return fallback;
}

export function agentAllowsSubscriptionFailoverAssign(
  agent: { adapterType: string; runtimeConfig?: unknown },
  provider: SubscriptionAdapterType,
) {
  if (!isSubscriptionAdapterType(agent.adapterType)) return false;
  if (agent.adapterType === provider) return true;
  const failover = readSubscriptionFailoverConfig(agent.runtimeConfig);
  return failover ? failover.order.includes(provider) : false;
}

export function resolveEffectiveSubscriptionAdapter(input: {
  agentAdapterType: string;
  runtimeConfig: unknown;
  contextSnapshot?: unknown;
}): SubscriptionAdapterType | null {
  if (!isSubscriptionAdapterType(input.agentAdapterType)) return null;
  const failover = readSubscriptionFailoverConfig(input.runtimeConfig);
  const context = asRecord(input.contextSnapshot);
  const forced = context?.paperclipEffectiveAdapterType;
  if (isSubscriptionAdapterType(forced) && failover?.order.includes(forced)) return forced;
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
    currentRetryNotBeforeValue
    && alternateRetryNotBeforeValue
    && new Date(currentRetryNotBeforeValue).getTime() <= new Date(alternateRetryNotBeforeValue).getTime(),
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
  quotaNotBeforeByProvider?: Partial<Record<SubscriptionAdapterType, string>>,
): Record<string, unknown> {
  const existing = asRecord(contextSnapshot.paperclipSubscriptionFailover);
  return {
    ...contextSnapshot,
    paperclipEffectiveAdapterType: nextAdapter,
    paperclipSubscriptionFailover: {
      ...existing,
      flippedAt: new Date().toISOString(),
      effectiveAdapterType: nextAdapter,
      ...(quotaNotBeforeByProvider ? { quotaNotBeforeByProvider } : {}),
    },
    // Cross-provider resume is unsafe; force a fresh harness session.
    forceFreshSession: true,
  };
}
