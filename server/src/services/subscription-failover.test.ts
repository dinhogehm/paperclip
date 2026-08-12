import { describe, expect, it } from "vitest";
import {
  agentAllowsSubscriptionFailoverAssign,
  defaultSubscriptionFailoverOrder,
  nextSubscriptionFailoverAdapter,
  readSubscriptionFailoverConfig,
  resolveEffectiveSubscriptionAdapter,
  withSubscriptionFailoverRetryContext,
  type SubscriptionAdapterType,
} from "./subscription-failover.js";

describe("subscription-failover helpers", () => {
  it("reads enabled failover config with valid order", () => {
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

  it("defaults invalid failover order to codex then claude", () => {
    expect(readSubscriptionFailoverConfig({
      subscriptionFailover: {
        enabled: true,
        order: ["codex_local", "codex_local"],
      },
    })).toEqual({
      enabled: true,
      order: defaultSubscriptionFailoverOrder("codex_local"),
    });
  });

  it("allows assign on secondary provider when failover is enabled", () => {
    const agent = {
      adapterType: "codex_local",
      runtimeConfig: {
        subscriptionFailover: {
          enabled: true,
          order: ["codex_local", "claude_local"],
        },
      },
    };
    expect(agentAllowsSubscriptionFailoverAssign(agent, "codex_local")).toBe(true);
    expect(agentAllowsSubscriptionFailoverAssign(agent, "claude_local")).toBe(true);
    expect(agentAllowsSubscriptionFailoverAssign(agent, "openai" as unknown as SubscriptionAdapterType)).toBe(false);
  });

  it("resolves effective adapter from retry context", () => {
    expect(resolveEffectiveSubscriptionAdapter({
      agentAdapterType: "codex_local",
      runtimeConfig: {
        subscriptionFailover: { enabled: true, order: ["codex_local", "claude_local"] },
      },
      contextSnapshot: { paperclipEffectiveAdapterType: "claude_local" },
    })).toBe("claude_local");
  });

  it("flips failover order on provider quota retry", () => {
    expect(nextSubscriptionFailoverAdapter({
      runtimeConfig: {
        subscriptionFailover: { enabled: true, order: ["codex_local", "claude_local"] },
      },
      currentAdapterType: "codex_local",
    })).toBe("claude_local");
    expect(nextSubscriptionFailoverAdapter({
      runtimeConfig: {
        subscriptionFailover: { enabled: true, order: ["codex_local", "claude_local"] },
      },
      currentAdapterType: "claude_local",
    })).toBe("codex_local");
  });

  it("marks retry context for cross-provider fresh session", () => {
    const next = withSubscriptionFailoverRetryContext({}, "claude_local");
    expect(next.paperclipEffectiveAdapterType).toBe("claude_local");
    expect(next.forceFreshSession).toBe(true);
    expect(next.paperclipSubscriptionFailover).toMatchObject({
      effectiveAdapterType: "claude_local",
    });
  });
});
