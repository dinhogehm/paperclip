import { describe, expect, it } from "vitest";
import {
  codexAccountIdFromRunContext,
  loadCodexAccountQuota,
  parseCodexDevicePrompt,
  resolveCodexLoginCommand,
  resolveCodexManagedAccountRunEnv,
  selectFirstAvailableCodexAccount,
  selectFirstAvailableCodexAccountWithDiagnostics,
  shouldBlockCodexSubscriptionAssignment,
  withCodexAccountSelectionLock,
} from "./codex-accounts.js";

const authenticated = {
  accessToken: "test-token",
  accountId: "chatgpt-account",
  refreshToken: "test-refresh",
  idToken: "test-id-token",
  email: "owner@example.com",
  planType: "pro",
  lastRefresh: "2026-08-10T12:00:00.000Z",
};

function quotaWindow(usedPercent: number) {
  return {
    label: "5h",
    usedPercent,
    resetsAt: null,
    valueLabel: null,
    detail: null,
  };
}

describe("Codex account device login", () => {
  it("diagnoses authentication, capacity, and quota exhaustion", async () => {
    const account = { id: "account-1", companyId: "company-1", name: "Primary" };
    const unauthenticated = await selectFirstAvailableCodexAccountWithDiagnostics({
      accounts: [account],
      readAuthInfo: async () => null,
    });
    expect(unauthenticated).toEqual({
      selection: null,
      reason: "no_authenticated",
      authenticatedCount: 0,
      withinSessionLimitCount: 0,
      availableQuotaCount: 0,
    });

    const atCapacity = await selectFirstAvailableCodexAccountWithDiagnostics({
      accounts: [account],
      busyAccountIds: [account.id, account.id],
      readAuthInfo: async () => authenticated,
      fetchQuota: async () => [quotaWindow(20)],
    });
    expect(atCapacity).toEqual({
      selection: null,
      reason: "capacity_exhausted",
      authenticatedCount: 1,
      withinSessionLimitCount: 0,
      availableQuotaCount: 0,
    });

    const quotaExhausted = await selectFirstAvailableCodexAccountWithDiagnostics({
      accounts: [account],
      preferAvailableOnly: true,
      readAuthInfo: async () => authenticated,
      fetchQuota: async () => [quotaWindow(96)],
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
    const result = await selectFirstAvailableCodexAccountWithDiagnostics({
      accounts: [
        { id: "account-1", companyId: "company-1", name: "Primary" },
        { id: "account-2", companyId: "company-1", name: "Secondary" },
      ],
      preferAvailableOnly: true,
      readAuthInfo: async () => authenticated,
      fetchQuota: async () => [quotaWindow(20)],
    });

    expect(result).toMatchObject({
      reason: "selected",
      authenticatedCount: 2,
      withinSessionLimitCount: 2,
      availableQuotaCount: 2,
      selection: { accountId: "account-1" },
    });
  });

  it("pins managed ChatGPT auth ahead of ambient API credentials", () => {
    expect(resolveCodexManagedAccountRunEnv("/profiles/codex-1")).toEqual({
      CODEX_HOME: "/profiles/codex-1",
      OPENAI_API_KEY: "",
      OPENAI_BASE_URL: "",
    });
  });

  it("allows host mode with an API key but keeps managed modes fail-closed", () => {
    const adapterConfig = { env: { OPENAI_API_KEY: { type: "secret_ref", secretId: "secret-1" } } };

    expect(shouldBlockCodexSubscriptionAssignment({
      adapterConfig,
      assignmentMode: "host",
      isPrimaryAdapter: true,
    })).toBe(false);
    expect(shouldBlockCodexSubscriptionAssignment({
      adapterConfig,
      assignmentMode: "fixed",
      isPrimaryAdapter: true,
    })).toBe(true);
    expect(shouldBlockCodexSubscriptionAssignment({
      adapterConfig,
      assignmentMode: "first_available",
      isPrimaryAdapter: true,
    })).toBe(true);
  });

  it("reads live account reservations from object and serialized run contexts", () => {
    const context = {
      paperclipCodexAccount: {
        mode: "first_available",
        accountId: "account-2",
      },
    };

    expect(codexAccountIdFromRunContext(context)).toBe("account-2");
    expect(codexAccountIdFromRunContext(JSON.stringify(context))).toBe("account-2");
    expect(codexAccountIdFromRunContext({})).toBeNull();
  });

  it("serializes simultaneous account reservations for the same company", async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const startedGate = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });

    const first = withCodexAccountSelectionLock("company-1", async () => {
      order.push("first:start");
      firstStarted();
      await firstGate;
      order.push("first:end");
    });
    const second = withCodexAccountSelectionLock("company-1", async () => {
      order.push("second:start");
      order.push("second:end");
    });

    await startedGate;
    expect(order).toEqual(["first:start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second:start", "second:end"]);
  });

  it("recognizes the current variable-length device code and strips terminal escapes", () => {
    const prompt = parseCodexDevicePrompt([
      "\u001b[1mWelcome to Codex\u001b[0m\r\n",
      "Open https://auth.openai.com/codex/device\r\n",
      "Enter this one-time code: abcd-efghi\r\n",
    ].join(""));

    expect(prompt).toEqual({
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "ABCD-EFGHI",
    });
  });

  it("uses a pseudo-terminal wrapper on macOS", () => {
    expect(resolveCodexLoginCommand("/opt/codex", "darwin")).toEqual({
      command: "/usr/bin/script",
      args: ["-q", "/dev/null", "/opt/codex", "login", "--device-auth"],
      detached: true,
    });
  });

  it("quotes a configured executable safely for the Linux script wrapper", () => {
    const command = resolveCodexLoginCommand("/opt/Codex user's/bin/codex", "linux");

    expect(command.command).toBe("/usr/bin/script");
    expect(command.args[3]).toBe("'/opt/Codex user'\"'\"'s/bin/codex' login --device-auth");
    expect(command.detached).toBe(true);
  });

  it("skips an exhausted account and chooses the first account with quota", async () => {
    const selection = await selectFirstAvailableCodexAccount({
      accounts: [
        { id: "account-1", companyId: "company-1", name: "Primary" },
        { id: "account-2", companyId: "company-1", name: "Secondary" },
      ],
      readAuthInfo: async (codexHome) => ({
        ...authenticated,
        accountId: codexHome?.includes("account-1")
          ? "chatgpt-account-1"
          : "chatgpt-account-2",
      }),
      fetchQuota: async (_token, accountId) => [
        quotaWindow(accountId === "chatgpt-account-1" ? 100 : 40),
      ],
    });

    expect(selection).toMatchObject({
      accountId: "account-2",
      accountName: "Secondary",
      quotaState: "available",
    });
  });

  it("uses the first non-busy account when another heartbeat is already using the primary", async () => {
    const selection = await selectFirstAvailableCodexAccount({
      accounts: [
        { id: "account-1", companyId: "company-1", name: "Primary" },
        { id: "account-2", companyId: "company-1", name: "Secondary" },
      ],
      busyAccountIds: ["account-1"],
      readAuthInfo: async () => authenticated,
      fetchQuota: async () => [quotaWindow(20)],
    });

    expect(selection).toMatchObject({
      accountId: "account-2",
      accountName: "Secondary",
      quotaState: "available",
    });
  });

  it("falls back to a busy account when every authenticated account is occupied", async () => {
    const selection = await selectFirstAvailableCodexAccount({
      accounts: [
        { id: "account-1", companyId: "company-1", name: "Primary" },
        { id: "account-2", companyId: "company-1", name: "Secondary" },
      ],
      busyAccountIds: ["account-1", "account-2"],
      readAuthInfo: async () => authenticated,
      fetchQuota: async () => [quotaWindow(20)],
    });

    expect(selection).toMatchObject({
      accountId: "account-1",
      accountName: "Primary",
      quotaState: "available",
    });
  });

  it("balances excess workers onto the least-loaded authenticated account", async () => {
    const selection = await selectFirstAvailableCodexAccount({
      accounts: [
        { id: "account-1", companyId: "company-1", name: "Primary" },
        { id: "account-2", companyId: "company-1", name: "Secondary" },
      ],
      busyAccountIds: ["account-1", "account-1", "account-2"],
      readAuthInfo: async () => authenticated,
      fetchQuota: async () => [quotaWindow(20)],
    });

    expect(selection).toMatchObject({
      accountId: "account-2",
      accountName: "Secondary",
      quotaState: "available",
    });
  });

  it("allows two sessions per account and rejects a third", async () => {
    const accounts = [{ id: "account-1", companyId: "company-1", name: "Primary" }];
    const second = await selectFirstAvailableCodexAccount({
      accounts,
      busyAccountIds: ["account-1"],
      readAuthInfo: async () => authenticated,
      fetchQuota: async () => [quotaWindow(20)],
    });
    expect(second?.accountId).toBe("account-1");

    const third = await selectFirstAvailableCodexAccount({
      accounts,
      busyAccountIds: ["account-1", "account-1"],
      readAuthInfo: async () => authenticated,
      fetchQuota: async () => [quotaWindow(20)],
    });
    expect(third).toBeNull();
  });

  it("prefers quota headroom over an account close to its weekly limit", async () => {
    const selection = await selectFirstAvailableCodexAccount({
      accounts: [
        { id: "account-1", companyId: "company-1", name: "Nearly exhausted" },
        { id: "account-2", companyId: "company-1", name: "Fresh" },
      ],
      busyAccountIds: ["account-2"],
      readAuthInfo: async (codexHome) => ({
        ...authenticated,
        accountId: codexHome?.includes("account-1") ? "chatgpt-account-1" : "chatgpt-account-2",
      }),
      fetchQuota: async (_token, accountId) => [
        quotaWindow(accountId === "chatgpt-account-1" ? 86 : 7),
      ],
    });

    expect(selection).toMatchObject({
      accountId: "account-2",
      accountName: "Fresh",
      quotaState: "available",
    });
  });

  it("treats 95 percent usage as the automatic-selection high-water mark", async () => {
    const selection = await selectFirstAvailableCodexAccount({
      accounts: [
        { id: "account-1", companyId: "company-1", name: "High water" },
        { id: "account-2", companyId: "company-1", name: "Usable" },
      ],
      readAuthInfo: async (codexHome) => ({
        ...authenticated,
        accountId: codexHome?.includes("account-1") ? "chatgpt-account-1" : "chatgpt-account-2",
      }),
      fetchQuota: async (_token, accountId) => [
        quotaWindow(accountId === "chatgpt-account-1" ? 95 : 80),
      ],
    });

    expect(selection).toMatchObject({ accountId: "account-2", quotaState: "available" });
  });

  it("reports live usage windows and their reset timestamps without exposing credentials", async () => {
    const quota = await loadCodexAccountQuota({
      accessToken: "private-access-token",
      providerAccountId: "chatgpt-account",
      now: () => new Date("2026-08-10T20:00:00.000Z"),
      fetchQuota: async () => [
        {
          label: "5h limit",
          usedPercent: 28,
          resetsAt: "2026-08-10T22:30:00.000Z",
          valueLabel: null,
          detail: null,
        },
        {
          label: "Weekly limit",
          usedPercent: 64,
          resetsAt: "2026-08-14T12:00:00.000Z",
          valueLabel: null,
          detail: null,
        },
      ],
    });

    expect(quota).toEqual({
      status: "available",
      fetchedAt: "2026-08-10T20:00:00.000Z",
      error: null,
      windows: [
        expect.objectContaining({ label: "5h limit", usedPercent: 28 }),
        expect.objectContaining({ label: "Weekly limit", usedPercent: 64 }),
      ],
    });
    expect(JSON.stringify(quota)).not.toContain("private-access-token");
  });

  it("turns quota probe failures into a retryable display state", async () => {
    const quota = await loadCodexAccountQuota({
      accessToken: "private-access-token",
      providerAccountId: "chatgpt-account",
      now: () => new Date("2026-08-10T20:00:00.000Z"),
      fetchQuota: async () => {
        throw new Error("provider response containing sensitive diagnostics");
      },
    });

    expect(quota).toEqual({
      status: "unknown",
      windows: [],
      fetchedAt: "2026-08-10T20:00:00.000Z",
      error: "Usage data is temporarily unavailable. Paperclip will try again automatically.",
    });
    expect(JSON.stringify(quota)).not.toContain("sensitive diagnostics");
  });

  it("returns null with preferAvailableOnly when only exhausted accounts exist", async () => {
    const selection = await selectFirstAvailableCodexAccount({
      accounts: [{ id: "account-1", companyId: "company-1", name: "Exhausted" }],
      preferAvailableOnly: true,
      readAuthInfo: async () => authenticated,
      fetchQuota: async () => [quotaWindow(96)],
    });
    expect(selection).toBeNull();
  });
});
