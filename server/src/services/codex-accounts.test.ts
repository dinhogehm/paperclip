import { describe, expect, it } from "vitest";
import {
  loadCodexAccountQuota,
  parseCodexDevicePrompt,
  resolveCodexLoginCommand,
  selectFirstAvailableCodexAccount,
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
});
