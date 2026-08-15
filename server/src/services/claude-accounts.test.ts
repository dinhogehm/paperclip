import { describe, expect, it } from "vitest";
import {
  claudeSubscriptionAssignmentBlocker,
  claudeAccountIdFromRunContext,
  resolveClaudeManagedAccountRunEnv,
  selectFirstAvailableClaudeAccount,
  selectFirstAvailableClaudeAccountWithDiagnostics,
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
  it("diagnoses authentication, capacity, and quota exhaustion", async () => {
    const account = { id: "account-1", companyId: "company-1", name: "Primary" };
    const unauthenticated = await selectFirstAvailableClaudeAccountWithDiagnostics({
      accounts: [account],
      readAuthStatus: async () => ({ loggedIn: false, authMethod: null, subscriptionType: null }),
    });
    expect(unauthenticated).toEqual({
      selection: null,
      reason: "no_authenticated",
      authenticatedCount: 0,
      withinSessionLimitCount: 0,
      availableQuotaCount: 0,
    });

    const atCapacity = await selectFirstAvailableClaudeAccountWithDiagnostics({
      accounts: [account],
      busyAccountIds: [account.id, account.id],
      readAuthStatus: async () => authenticated,
      readQuota: async () => quota(20),
    });
    expect(atCapacity).toEqual({
      selection: null,
      reason: "capacity_exhausted",
      authenticatedCount: 1,
      withinSessionLimitCount: 0,
      availableQuotaCount: 0,
    });

    const quotaExhausted = await selectFirstAvailableClaudeAccountWithDiagnostics({
      accounts: [account],
      preferAvailableOnly: true,
      readAuthStatus: async () => authenticated,
      readQuota: async () => quota(96),
    });
    expect(quotaExhausted).toEqual({
      selection: null,
      reason: "quota_exhausted",
      authenticatedCount: 1,
      withinSessionLimitCount: 1,
      availableQuotaCount: 0,
    });
  });

  it("reports eligible account counts alongside a successful selection", async () => {
    const result = await selectFirstAvailableClaudeAccountWithDiagnostics({
      accounts: [
        { id: "account-1", companyId: "company-1", name: "Primary" },
        { id: "account-2", companyId: "company-1", name: "Secondary" },
      ],
      preferAvailableOnly: true,
      readAuthStatus: async () => authenticated,
      readQuota: async () => quota(20),
    });

    expect(result).toMatchObject({
      reason: "selected",
      authenticatedCount: 2,
      withinSessionLimitCount: 2,
      availableQuotaCount: 2,
      selection: { accountId: "account-1" },
    });
  });

  it("pins managed claude.ai auth ahead of ambient API/provider credentials", () => {
    expect(resolveClaudeManagedAccountRunEnv("/profiles/claude-1")).toMatchObject({
      CLAUDE_CONFIG_DIR: "/profiles/claude-1",
      CLAUDE_SECURESTORAGE_CONFIG_DIR: "/profiles/claude-1",
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_AUTH_TOKEN: "",
      ANTHROPIC_BASE_URL: "",
      CLAUDE_CODE_OAUTH_TOKEN: "",
      CLAUDE_CODE_USE_BEDROCK: "",
      CLAUDE_CODE_USE_VERTEX: "",
      CLAUDE_CODE_USE_FOUNDRY: "",
    });
  });

  it("allows host mode with provider credentials but keeps managed modes fail-closed", () => {
    const adapterConfig = { env: { ANTHROPIC_API_KEY: "configured" } };

    expect(claudeSubscriptionAssignmentBlocker({
      adapterConfig,
      assignmentMode: "host",
      isPrimaryAdapter: true,
    })).toBeNull();
    expect(claudeSubscriptionAssignmentBlocker({
      adapterConfig,
      assignmentMode: "fixed",
      isPrimaryAdapter: true,
    })).toBe("ANTHROPIC_API_KEY");
    expect(claudeSubscriptionAssignmentBlocker({
      adapterConfig,
      assignmentMode: "first_available",
      isPrimaryAdapter: true,
    })).toBe("ANTHROPIC_API_KEY");
  });

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

  it("returns null with preferAvailableOnly when only exhausted accounts exist", async () => {
    const selection = await selectFirstAvailableClaudeAccount({
      accounts: [{ id: "account-1", companyId: "company-1", name: "Exhausted" }],
      preferAvailableOnly: true,
      readAuthStatus: async () => authenticated,
      readQuota: async () => quota(96),
    });
    expect(selection).toBeNull();
  });
});
