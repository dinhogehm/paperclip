import { describe, expect, it } from "vitest";
import {
  agentAllowsSubscriptionFailoverAssign,
  nextSubscriptionFailoverAdapter,
  readSubscriptionFailoverConfig,
  resetSubscriptionProviderSelectionForCapacityRetry,
  resolveCrossProviderProcessEnvOverrides,
  resolveEffectiveSubscriptionAdapter,
  sanitizeResolvedSubscriptionAdapterConfig,
  resolveSubscriptionAdapterConfig,
  resolveSubscriptionFailoverRetryTiming,
  stripSubscriptionProviderSpecificEnv,
  withSubscriptionFailoverRetryContext,
  type SubscriptionAdapterType,
} from "./subscription-failover.js";

const failoverConfig = {
  subscriptionFailover: {
    enabled: true,
    order: ["codex_local", "claude_local"],
  },
};

describe("subscription failover helpers", () => {
  it("reads enabled failover config with either valid order", () => {
    expect(readSubscriptionFailoverConfig({
      subscriptionFailover: {
        enabled: true,
        order: ["claude_local", "codex_local"],
      },
    })).toEqual({
      enabled: true,
      order: ["claude_local", "codex_local"],
    });
  });

  it("disables an invalid legacy order instead of silently changing providers", () => {
    expect(readSubscriptionFailoverConfig({
      subscriptionFailover: {
        enabled: true,
        order: ["codex_local", "codex_local"],
      },
    })).toBeNull();
    expect(readSubscriptionFailoverConfig({
      subscriptionFailover: {
        enabled: true,
      },
    })).toBeNull();
  });

  it("allows account assignment on the secondary provider only while failover is enabled", () => {
    const agent = {
      adapterType: "codex_local",
      runtimeConfig: failoverConfig,
    };
    expect(agentAllowsSubscriptionFailoverAssign(agent, "codex_local")).toBe(true);
    expect(agentAllowsSubscriptionFailoverAssign(agent, "claude_local")).toBe(true);
    expect(agentAllowsSubscriptionFailoverAssign(
      agent,
      "openai" as unknown as SubscriptionAdapterType,
    )).toBe(false);
    expect(agentAllowsSubscriptionFailoverAssign({
      adapterType: "process",
      runtimeConfig: failoverConfig,
    }, "codex_local")).toBe(false);
  });

  it("honors a retry provider only while it remains in the active failover policy", () => {
    expect(resolveEffectiveSubscriptionAdapter({
      agentAdapterType: "codex_local",
      runtimeConfig: failoverConfig,
      contextSnapshot: { paperclipEffectiveAdapterType: "claude_local" },
    })).toBe("claude_local");

    expect(resolveEffectiveSubscriptionAdapter({
      agentAdapterType: "codex_local",
      runtimeConfig: {},
      contextSnapshot: { paperclipEffectiveAdapterType: "claude_local" },
    })).toBe("codex_local");

    expect(resolveEffectiveSubscriptionAdapter({
      agentAdapterType: "process",
      runtimeConfig: failoverConfig,
      contextSnapshot: { paperclipEffectiveAdapterType: "claude_local" },
    })).toBeNull();
  });

  it("flips failover order on provider quota retry", () => {
    expect(nextSubscriptionFailoverAdapter({
      runtimeConfig: failoverConfig,
      currentAdapterType: "codex_local",
    })).toBe("claude_local");
    expect(nextSubscriptionFailoverAdapter({
      runtimeConfig: failoverConfig,
      currentAdapterType: "claude_local",
    })).toBe("codex_local");
  });

  it("keeps the primary config and applies its explicit provider model", () => {
    expect(resolveSubscriptionAdapterConfig({
      adapterConfig: {
        model: "gpt-primary",
        command: "custom-codex",
        cwd: "/workspace",
      },
      agentAdapterType: "codex_local",
      effectiveAdapterType: "codex_local",
      failover: {
        enabled: true,
        order: ["codex_local", "claude_local"],
        models: { codex_local: "gpt-configured" },
      },
    })).toEqual({
      model: "gpt-configured",
      command: "custom-codex",
      cwd: "/workspace",
    });
  });

  it("does not leak primary provider commands or models into the fallback adapter", () => {
    expect(resolveSubscriptionAdapterConfig({
      adapterConfig: {
        model: "gpt-primary",
        command: "custom-codex",
        extraArgs: ["--codex-only"],
        modelReasoningEffort: "high",
        cwd: "/workspace",
        promptTemplate: "Work on the assigned task",
        env: {
          GH_TOKEN: "secret-ref",
          CODEX_HOME: "/private/codex",
          OPENAI_API_KEY: "must-not-cross",
          OPENAI_ORGANIZATION: "must-not-cross",
          ANTHROPIC_FOUNDRY_RESOURCE: "must-not-cross",
          CLAUDE_CODE_USE_BEDROCK: "1",
          AWS_ACCESS_KEY_ID: "shared-aws-key",
          AWS_REGION: "shared-aws-region",
          GOOGLE_APPLICATION_CREDENTIALS: "/shared/google.json",
          CLOUD_ML_REGION: "shared-cloud-region",
        },
      },
      agentAdapterType: "codex_local",
      effectiveAdapterType: "claude_local",
      failover: {
        enabled: true,
        order: ["codex_local", "claude_local"],
        models: { claude_local: "claude-fallback" },
      },
    })).toEqual({
      model: "claude-fallback",
      cwd: "/workspace",
      promptTemplate: "Work on the assigned task",
      env: {
        GH_TOKEN: "secret-ref",
        AWS_ACCESS_KEY_ID: "shared-aws-key",
        AWS_REGION: "shared-aws-region",
        GOOGLE_APPLICATION_CREDENTIALS: "/shared/google.json",
        CLOUD_ML_REGION: "shared-cloud-region",
      },
    });
  });

  it("removes provider credentials reintroduced after cross-provider env resolution", () => {
    expect(sanitizeResolvedSubscriptionAdapterConfig({
      adapterConfig: {
        command: "claude",
        model: "claude-effective",
        env: {
          GH_TOKEN: "shared-github-token",
          OPENAI_API_KEY: "resolved-primary-secret",
          AZURE_OPENAI_API_KEY: "resolved-primary-azure-secret",
          ANTHROPIC_API_KEY: "resolved-target-secret",
          CLAUDE_CODE_USE_BEDROCK: "1",
          AWS_ACCESS_KEY_ID: "shared-deploy-secret",
          GOOGLE_APPLICATION_CREDENTIALS: "/shared/deploy.json",
        },
      },
      agentAdapterType: "codex_local",
      effectiveAdapterType: "claude_local",
    })).toEqual({
      command: "claude",
      model: "claude-effective",
      env: {
        GH_TOKEN: "shared-github-token",
        AWS_ACCESS_KEY_ID: "shared-deploy-secret",
        GOOGLE_APPLICATION_CREDENTIALS: "/shared/deploy.json",
      },
    });
  });

  it("preserves resolved provider env for a same-provider run", () => {
    const adapterConfig = {
      env: {
        OPENAI_API_KEY: "project-scoped-key",
        GH_TOKEN: "shared-github-token",
      },
    };
    expect(sanitizeResolvedSubscriptionAdapterConfig({
      adapterConfig,
      agentAdapterType: "codex_local",
      effectiveAdapterType: "codex_local",
    })).toEqual(adapterConfig);
  });

  it("neutralizes ambient credentials from the inactive provider during failover", () => {
    const processEnv = {
      OPENAI_API_KEY: "ambient-openai",
      CODEX_HOME: "/ambient/codex",
      AZURE_OPENAI_ENDPOINT: "https://ambient.example",
      ANTHROPIC_API_KEY: "ambient-anthropic",
      CLAUDE_CONFIG_DIR: "/ambient/claude",
      AWS_ACCESS_KEY_ID: "shared-ambient-aws",
      GH_TOKEN: "shared-github-token",
    };

    expect(resolveCrossProviderProcessEnvOverrides({
      processEnv,
      agentAdapterType: "codex_local",
      effectiveAdapterType: "claude_local",
    })).toEqual({
      OPENAI_API_KEY: "",
      CODEX_HOME: "",
      AZURE_OPENAI_ENDPOINT: "",
    });
    expect(resolveCrossProviderProcessEnvOverrides({
      processEnv,
      agentAdapterType: "claude_local",
      effectiveAdapterType: "codex_local",
    })).toEqual({
      ANTHROPIC_API_KEY: "",
      CLAUDE_CONFIG_DIR: "",
    });
    expect(resolveCrossProviderProcessEnvOverrides({
      processEnv,
      agentAdapterType: "codex_local",
      effectiveAdapterType: "codex_local",
    })).toEqual({});
  });

  it("drops provider secret refs before cross-provider binding resolution", () => {
    expect(stripSubscriptionProviderSpecificEnv({
      OPENAI_API_KEY: { type: "secret_ref", secretId: "primary-openai" },
      ANTHROPIC_API_KEY: { type: "secret_ref", secretId: "target-anthropic" },
      GH_TOKEN: { type: "secret_ref", secretId: "shared-github" },
      SHARED_PLAIN: "keep-me",
    })).toEqual({
      GH_TOKEN: { type: "secret_ref", secretId: "shared-github" },
      SHARED_PLAIN: "keep-me",
    });
  });

  it("clears a capacity-bound provider pin while retaining quota deadlines", () => {
    expect(resetSubscriptionProviderSelectionForCapacityRetry({
      paperclipEffectiveAdapterType: "claude_local",
      paperclipClaudeAccount: { accountId: "busy-account" },
      paperclipSubscriptionFailover: {
        effectiveAdapterType: "claude_local",
        flippedAt: "2026-08-15T12:00:00.000Z",
        quotaNotBeforeByProvider: {
          codex_local: "2026-08-20T00:00:00.000Z",
        },
      },
      forceFreshSession: true,
    }, true)).toEqual({
      paperclipSubscriptionFailover: {
        flippedAt: "2026-08-15T12:00:00.000Z",
        quotaNotBeforeByProvider: {
          codex_local: "2026-08-20T00:00:00.000Z",
        },
      },
      forceFreshSession: true,
    });
  });

  it("marks cross-provider retry context for a fresh session and preserves quota deadlines", () => {
    const next = withSubscriptionFailoverRetryContext(
      {},
      "claude_local",
      { codex_local: "2026-08-20T00:00:00.000Z" },
    );
    expect(next.paperclipEffectiveAdapterType).toBe("claude_local");
    expect(next.forceFreshSession).toBe(true);
    expect(next.paperclipSubscriptionFailover).toMatchObject({
      effectiveAdapterType: "claude_local",
      quotaNotBeforeByProvider: { codex_local: "2026-08-20T00:00:00.000Z" },
    });
  });
});

describe("subscription failover quota retry timing", () => {
  it("drops a 145-hour Codex reset when Claude has no known deadline", () => {
    const now = new Date("2026-08-13T23:00:00.000Z");
    const reset = new Date(now.getTime() + 145 * 60 * 60 * 1000);
    const timing = resolveSubscriptionFailoverRetryTiming({
      runtimeConfig: failoverConfig,
      currentAdapterType: "codex_local",
      retryNotBefore: reset,
    });

    expect(timing.failoverRetryAdapter).toBe("claude_local");
    expect(timing.switchesProvider).toBe(true);
    expect(timing.effectiveRetryNotBefore).toBeNull();
    expect(timing.quotaNotBeforeByProvider).toEqual({
      codex_local: reset.toISOString(),
    });
    const boundedRetryDueAt = new Date(now.getTime() + 2 * 60 * 1000);
    const scheduledDueAt = timing.effectiveRetryNotBefore && timing.effectiveRetryNotBefore > boundedRetryDueAt
      ? timing.effectiveRetryNotBefore
      : boundedRetryDueAt;
    expect(scheduledDueAt.toISOString()).toBe("2026-08-13T23:02:00.000Z");
  });

  it("preserves the reset when failover is disabled", () => {
    const reset = new Date("2026-08-20T00:00:00.000Z");
    const timing = resolveSubscriptionFailoverRetryTiming({
      runtimeConfig: {},
      currentAdapterType: "codex_local",
      retryNotBefore: reset,
    });

    expect(timing.failoverRetryAdapter).toBeNull();
    expect(timing.switchesProvider).toBe(false);
    expect(timing.effectiveRetryNotBefore).toEqual(reset);
  });

  it("does not ping-pong to a provider with a later known reset", () => {
    const claudeReset = new Date("2026-08-14T01:00:00.000Z");
    const codexReset = "2026-08-20T00:00:00.000Z";
    const timing = resolveSubscriptionFailoverRetryTiming({
      runtimeConfig: failoverConfig,
      currentAdapterType: "claude_local",
      retryNotBefore: claudeReset,
      contextSnapshot: {
        paperclipSubscriptionFailover: {
          quotaNotBeforeByProvider: { codex_local: codexReset },
        },
      },
    });

    expect(timing.failoverRetryAdapter).toBeNull();
    expect(timing.switchesProvider).toBe(false);
    expect(timing.effectiveRetryNotBefore).toEqual(claudeReset);
    expect(timing.quotaNotBeforeByProvider).toEqual({
      codex_local: codexReset,
      claude_local: claudeReset.toISOString(),
    });
  });

  it("switches to the provider with the earlier known reset", () => {
    const claudeReset = new Date("2026-08-20T00:00:00.000Z");
    const codexReset = "2026-08-14T01:00:00.000Z";
    const timing = resolveSubscriptionFailoverRetryTiming({
      runtimeConfig: failoverConfig,
      currentAdapterType: "claude_local",
      retryNotBefore: claudeReset,
      contextSnapshot: {
        paperclipSubscriptionFailover: {
          quotaNotBeforeByProvider: { codex_local: codexReset },
        },
      },
    });

    expect(timing.failoverRetryAdapter).toBe("codex_local");
    expect(timing.switchesProvider).toBe(true);
    expect(timing.effectiveRetryNotBefore?.toISOString()).toBe(codexReset);
  });
});
