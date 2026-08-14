import { describe, expect, it } from "vitest";
import {
  claudeAccountIdFromRunContext,
  selectFirstAvailableClaudeAccount,
  withClaudeAccountSelectionLock,
} from "./claude-accounts.js";

const authenticated = { loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" };

function quota(usedPercent: number) {
  return {
    provider: "anthropic" as const,
    source: "test",
    ok: true as const,
    windows: [{ label: "Current week", usedPercent, resetsAt: null, valueLabel: null, detail: null }],
  };
}

describe("Claude account selection", () => {
  it("reads live reservations from object and serialized contexts", () => {
    const context = { paperclipClaudeAccount: { accountId: "account-2" } };
    expect(claudeAccountIdFromRunContext(context)).toBe("account-2");
    expect(claudeAccountIdFromRunContext(JSON.stringify(context))).toBe("account-2");
    expect(claudeAccountIdFromRunContext({})).toBeNull();
  });

  it("serializes simultaneous selections for one company", async () => {
    const order: string[] = [];
    let release!: () => void;
    let markStarted!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const first = withClaudeAccountSelectionLock("company-1", async () => {
      order.push("first:start");
      markStarted();
      await gate;
      order.push("first:end");
    });
    const second = withClaudeAccountSelectionLock("company-1", async () => { order.push("second"); });
    await started;
    expect(order).toEqual(["first:start"]);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second"]);
  });

  it("skips an exhausted account and chooses quota headroom", async () => {
    const selection = await selectFirstAvailableClaudeAccount({
      accounts: [
        { id: "account-1", companyId: "company-1", name: "Nearly exhausted" },
        { id: "account-2", companyId: "company-1", name: "Available" },
      ],
      readAuthStatus: async () => authenticated,
      readQuota: async (env) => quota(env?.CLAUDE_CONFIG_DIR?.includes("account-1") ? 96 : 35),
    });
    expect(selection).toMatchObject({ accountId: "account-2", quotaState: "available" });
  });

  it("balances equal-quota accounts using live reservations", async () => {
    const selection = await selectFirstAvailableClaudeAccount({
      accounts: [
        { id: "account-1", companyId: "company-1", name: "Primary" },
        { id: "account-2", companyId: "company-1", name: "Secondary" },
      ],
      busyAccountIds: ["account-1"],
      readAuthStatus: async () => authenticated,
      readQuota: async () => quota(20),
    });
    expect(selection).toMatchObject({ accountId: "account-2", accountName: "Secondary" });
  });

  it("allows two sessions per account and rejects a third", async () => {
    const accounts = [{ id: "account-1", companyId: "company-1", name: "Primary" }];
    const second = await selectFirstAvailableClaudeAccount({
      accounts,
      busyAccountIds: ["account-1"],
      readAuthStatus: async () => authenticated,
      readQuota: async () => quota(20),
    });
    expect(second?.accountId).toBe("account-1");

    const third = await selectFirstAvailableClaudeAccount({
      accounts,
      busyAccountIds: ["account-1", "account-1"],
      readAuthStatus: async () => authenticated,
      readQuota: async () => quota(20),
    });
    expect(third).toBeNull();
  });

  it("ignores profiles that are not authenticated through claude.ai", async () => {
    const selection = await selectFirstAvailableClaudeAccount({
      accounts: [{ id: "account-1", companyId: "company-1", name: "API login" }],
      readAuthStatus: async () => ({ loggedIn: true, authMethod: "api_key", subscriptionType: null }),
      readQuota: async () => quota(10),
    });
    expect(selection).toBeNull();
  });
});
