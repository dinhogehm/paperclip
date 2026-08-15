import { describe, expect, it } from "vitest";
import { createAgentSchema } from "./agent.js";

describe("agent subscription failover runtime config", () => {
  it("accepts either provider order and provider-specific models", () => {
    const parsed = createAgentSchema.parse({
      name: "Delivery engineer",
      adapterType: "codex_local",
      runtimeConfig: {
        heartbeat: { enabled: true },
        subscriptionFailover: {
          enabled: true,
          order: ["claude_local", "codex_local"],
          models: {
            codex_local: "gpt-5.3-codex",
            claude_local: "claude-opus-4-1",
          },
        },
      },
    });

    expect(parsed.runtimeConfig.subscriptionFailover).toEqual({
      enabled: true,
      order: ["claude_local", "codex_local"],
      models: {
        codex_local: "gpt-5.3-codex",
        claude_local: "claude-opus-4-1",
      },
    });
    expect(parsed.runtimeConfig.heartbeat).toEqual({ enabled: true });
  });

  it("rejects an order that repeats the same provider", () => {
    const parsed = createAgentSchema.safeParse({
      name: "Delivery engineer",
      adapterType: "codex_local",
      runtimeConfig: {
        subscriptionFailover: {
          enabled: true,
          order: ["codex_local", "codex_local"],
        },
      },
    });

    expect(parsed.success).toBe(false);
  });

  it("rejects unknown provider model keys and empty models", () => {
    const unknownProvider = createAgentSchema.safeParse({
      name: "Delivery engineer",
      adapterType: "codex_local",
      runtimeConfig: {
        subscriptionFailover: {
          enabled: true,
          order: ["codex_local", "claude_local"],
          models: { gemini_local: "gemini-pro" },
        },
      },
    });
    const emptyModel = createAgentSchema.safeParse({
      name: "Delivery engineer",
      adapterType: "codex_local",
      runtimeConfig: {
        subscriptionFailover: {
          enabled: true,
          order: ["codex_local", "claude_local"],
          models: { claude_local: "   " },
        },
      },
    });

    expect(unknownProvider.success).toBe(false);
    expect(emptyModel.success).toBe(false);
  });
});
