import { describe, expect, it } from "vitest";
import { resolveSubscriptionFailoverRetryTiming } from "./subscription-failover.js";

const failoverConfig = {
  subscriptionFailover: {
    enabled: true,
    order: ["codex_local", "claude_local"],
  },
};

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
