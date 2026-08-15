// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import { CompanyAgentAssignments } from "./CompanyAgentAssignments";

const agentAssignmentsApiMock = vi.hoisted(() => ({ list: vi.fn(), update: vi.fn() }));
const codexApiMock = vi.hoisted(() => ({ list: vi.fn() }));
const claudeApiMock = vi.hoisted(() => ({ list: vi.fn() }));

vi.mock("@/api/agentAssignments", () => ({ agentAssignmentsApi: agentAssignmentsApiMock }));
vi.mock("@/api/codexAccounts", () => ({ codexAccountsApi: codexApiMock }));
vi.mock("@/api/claudeAccounts", () => ({ claudeAccountsApi: claudeApiMock }));
vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    selectedCompany: { id: "company-1", name: "NUR" },
  }),
}));
vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: { children: React.ReactNode; to: string }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const dualAgent = {
  id: "dual-agent",
  name: "Dual Delivery",
  status: "paused",
  adapterType: "codex_local",
  adapterConfig: {},
  runtimeConfig: {
    subscriptionFailover: {
      enabled: true,
      order: ["codex_local", "claude_local"],
    },
  },
  permissions: {},
  codexAccountMode: "fixed",
  codexAccountId: "codex-account",
  claudeAccountMode: "fixed",
  claudeAccountId: "claude-account",
  updatedAt: "2026-08-15T12:00:00.000Z",
};
const reverseAgent = {
  ...dualAgent,
  id: "reverse-agent",
  name: "Reverse Reviewer",
  runtimeConfig: {
    subscriptionFailover: {
      enabled: true,
      order: ["claude_local", "codex_local"],
    },
  },
};
const singleAgent = {
  ...dualAgent,
  id: "single-agent",
  name: "Single Engineer",
  runtimeConfig: {},
  claudeAccountMode: "host",
  claudeAccountId: null,
};

async function waitFor(assertion: () => void) {
  let lastError: unknown;
  for (let index = 0; index < 40; index += 1) {
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

describe("CompanyAgentAssignments", () => {
  let container: HTMLDivElement;
  let root: Root | null;

  const renderPage = async () => {
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <CompanyAgentAssignments />
        </QueryClientProvider>,
      );
    });
    await waitFor(() => expect(
      container.querySelector('select[aria-label^="Provider strategy for "]'),
    ).not.toBeNull());
  };

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = null;
    agentAssignmentsApiMock.list.mockResolvedValue({
      assignments: [dualAgent, reverseAgent, singleAgent].map((agent) => ({
        agent,
        assignmentVersion: `${agent.id}-v1`,
      })),
    });
    codexApiMock.list.mockResolvedValue({
      accounts: [{ id: "codex-account", name: "Codex Pro", authenticated: true }],
      agents: [],
    });
    claudeApiMock.list.mockResolvedValue({
      accounts: [
        { id: "claude-account", name: "Claude Max", authenticated: true },
        { id: "claude-account-2", name: "Claude Max 2", authenticated: true },
      ],
      agents: [],
    });
    agentAssignmentsApiMock.update.mockImplementation(async (_companyId, agentId) => ({
      agent: [dualAgent, reverseAgent, singleAgent].find((agent) => agent.id === agentId),
      assignmentVersion: `${agentId}-v2`,
    }));
  });

  afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("shows both failover directions in priority order with independent accounts", async () => {
    await renderPage();
    const dualStrategy = container.querySelector(
      'select[aria-label="Provider strategy for Dual Delivery"]',
    ) as HTMLSelectElement;
    const reverseStrategy = container.querySelector(
      'select[aria-label="Provider strategy for Reverse Reviewer"]',
    ) as HTMLSelectElement;

    expect(dualStrategy.value).toBe("codex_then_claude");
    expect(reverseStrategy.value).toBe("claude_then_codex");
    expect(container.textContent).toContain("Codex account · Primary");
    expect(container.textContent).toContain("Claude account · Fallback");
    expect(container.textContent).toContain("Claude account · Primary");
    expect(container.textContent).toContain("Codex account · Fallback");
    expect(container.textContent).toContain("On Railway, prefer a managed account");
  });

  it("enables both providers with one versioned atomic request", async () => {
    await renderPage();
    const strategy = container.querySelector(
      'select[aria-label="Provider strategy for Single Engineer"]',
    ) as HTMLSelectElement;

    await act(async () => {
      strategy.value = "codex_then_claude";
      strategy.dispatchEvent(new Event("change", { bubbles: true }));
    });

    await waitFor(() => expect(agentAssignmentsApiMock.update).toHaveBeenCalledTimes(1));
    expect(agentAssignmentsApiMock.update).toHaveBeenCalledWith("company-1", "single-agent", {
      strategy: "failover",
      preferredProvider: "codex_local",
      codex: { mode: "fixed", accountId: "codex-account" },
      claude: { mode: "first_available", accountId: null },
      expectedAssignmentVersion: "single-agent-v1",
    });
  });

  it("updates Claude without clearing Codex", async () => {
    await renderPage();
    const claudeAccount = container.querySelector(
      'select[aria-label="Claude account for Dual Delivery"]',
    ) as HTMLSelectElement;

    await act(async () => {
      claudeAccount.value = "claude-account-2";
      claudeAccount.dispatchEvent(new Event("change", { bubbles: true }));
    });

    await waitFor(() => expect(agentAssignmentsApiMock.update).toHaveBeenCalledTimes(1));
    expect(agentAssignmentsApiMock.update).toHaveBeenCalledWith("company-1", "dual-agent", {
      strategy: "failover",
      preferredProvider: "codex_local",
      codex: { mode: "fixed", accountId: "codex-account" },
      claude: { mode: "fixed", accountId: "claude-account-2" },
      expectedAssignmentVersion: "dual-agent-v1",
    });
  });

  it("uses the returned atomic snapshot and version for the next row update", async () => {
    const firstSavedAgent = {
      ...dualAgent,
      claudeAccountId: "claude-account-2",
    };
    agentAssignmentsApiMock.update
      .mockResolvedValueOnce({ agent: firstSavedAgent, assignmentVersion: "dual-agent-v2" })
      .mockResolvedValueOnce({
        agent: { ...firstSavedAgent, claudeAccountMode: "host", claudeAccountId: null },
        assignmentVersion: "dual-agent-v3",
      });
    await renderPage();
    const claudeAccount = container.querySelector(
      'select[aria-label="Claude account for Dual Delivery"]',
    ) as HTMLSelectElement;

    await act(async () => {
      claudeAccount.value = "claude-account-2";
      claudeAccount.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await waitFor(() => {
      expect(agentAssignmentsApiMock.update).toHaveBeenCalledTimes(1);
      expect(claudeAccount.value).toBe("claude-account-2");
    });

    await act(async () => {
      claudeAccount.value = "";
      claudeAccount.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await waitFor(() => expect(agentAssignmentsApiMock.update).toHaveBeenCalledTimes(2));
    expect(agentAssignmentsApiMock.update.mock.calls[1]?.[2]).toMatchObject({
      codex: { mode: "fixed", accountId: "codex-account" },
      claude: { mode: "host", accountId: null },
      expectedAssignmentVersion: "dual-agent-v2",
    });
  });

  it("shows a fixed unauthenticated account and safely normalizes it when activating the provider", async () => {
    const agent = {
      ...singleAgent,
      claudeAccountMode: "fixed",
      claudeAccountId: "claude-old",
    };
    agentAssignmentsApiMock.list.mockResolvedValue({
      assignments: [{ agent, assignmentVersion: "single-v1" }],
    });
    claudeApiMock.list.mockResolvedValue({
      accounts: [
        { id: "claude-old", name: "Expired Claude", authenticated: false },
        { id: "claude-account", name: "Claude Max", authenticated: true },
      ],
      agents: [],
    });
    await renderPage();

    const strategy = container.querySelector(
      'select[aria-label="Provider strategy for Single Engineer"]',
    ) as HTMLSelectElement;
    await act(async () => {
      strategy.value = "codex_then_claude";
      strategy.dispatchEvent(new Event("change", { bubbles: true }));
    });

    await waitFor(() => expect(agentAssignmentsApiMock.update).toHaveBeenCalledTimes(1));
    expect(agentAssignmentsApiMock.update.mock.calls[0]?.[2]).toMatchObject({
      claude: { mode: "first_available", accountId: null },
    });
  });

  it("keeps an unauthenticated current account visible and disabled", async () => {
    const expiredAgent = {
      ...dualAgent,
      claudeAccountId: "claude-old",
    };
    agentAssignmentsApiMock.list.mockResolvedValue({
      assignments: [{ agent: expiredAgent, assignmentVersion: "dual-v1" }],
    });
    claudeApiMock.list.mockResolvedValue({
      accounts: [{ id: "claude-old", name: "Expired Claude", authenticated: false }],
      agents: [],
    });
    await renderPage();

    const select = container.querySelector(
      'select[aria-label="Claude account for Dual Delivery"]',
    ) as HTMLSelectElement;
    const option = select.querySelector('option[value="claude-old"]') as HTMLOptionElement;
    const firstAvailable = select.querySelector(`option[value="__first_available__"]`) as HTMLOptionElement;
    const codexSelect = container.querySelector(
      'select[aria-label="Codex account for Dual Delivery"]',
    ) as HTMLSelectElement;
    const strategy = container.querySelector(
      'select[aria-label="Provider strategy for Dual Delivery"]',
    ) as HTMLSelectElement;
    expect(select.value).toBe("claude-old");
    expect(select.disabled).toBe(false);
    expect(codexSelect.disabled).toBe(true);
    expect(option.disabled).toBe(true);
    expect(option.textContent).toContain("not authenticated");
    expect(firstAvailable.disabled).toBe(true);
    expect(strategy.querySelector('option[value="codex_only"]')?.hasAttribute("disabled")).toBe(false);
    expect(strategy.querySelector('option[value="codex_then_claude"]')?.hasAttribute("disabled")).toBe(true);

    await act(async () => {
      select.value = "";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await waitFor(() => expect(agentAssignmentsApiMock.update).toHaveBeenCalledTimes(1));
    expect(agentAssignmentsApiMock.update.mock.calls[0]?.[2]).toMatchObject({
      strategy: "failover",
      claude: { mode: "host", accountId: null },
    });
  });

  it("restores provider blockers and disables affected strategies", async () => {
    codexApiMock.list.mockResolvedValue({
      accounts: [{ id: "codex-account", name: "Codex Pro", authenticated: true }],
      agents: [{
        id: "dual-agent",
        canUseSubscriptionAccount: false,
        subscriptionAccountBlocker: "Remove OPENAI_API_KEY before assigning a ChatGPT account.",
      }],
    });
    await renderPage();

    const codexAccount = container.querySelector(
      'select[aria-label="Codex account for Dual Delivery"]',
    ) as HTMLSelectElement;
    const strategy = container.querySelector(
      'select[aria-label="Provider strategy for Dual Delivery"]',
    ) as HTMLSelectElement;
    expect(codexAccount.disabled).toBe(false);
    expect(container.textContent).toContain("Remove OPENAI_API_KEY");
    expect(strategy.querySelector('option[value="codex_only"]')?.hasAttribute("disabled")).toBe(true);
    expect(strategy.querySelector('option[value="claude_only"]')?.hasAttribute("disabled")).toBe(false);
    expect(codexAccount.querySelector('option[value=""]')?.hasAttribute("disabled")).toBe(false);
    expect(codexAccount.querySelector('option[value="codex-account"]')?.hasAttribute("disabled")).toBe(true);

    await act(async () => {
      codexAccount.value = "";
      codexAccount.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await waitFor(() => expect(agentAssignmentsApiMock.update).toHaveBeenCalledTimes(1));
    expect(agentAssignmentsApiMock.update.mock.calls[0]?.[2]).toMatchObject({
      strategy: "failover",
      codex: { mode: "host", accountId: null },
    });
  });

  it("activates a blocked managed provider through its valid host mode", async () => {
    agentAssignmentsApiMock.list.mockResolvedValue({
      assignments: [{ agent: singleAgent, assignmentVersion: "single-v1" }],
    });
    claudeApiMock.list.mockResolvedValue({
      accounts: [{ id: "claude-account", name: "Claude Max", authenticated: true }],
      agents: [{
        id: "single-agent",
        canUseSubscriptionAccount: false,
        subscriptionAccountBlocker: "Remove ANTHROPIC_API_KEY before assigning a Claude account.",
      }],
    });
    await renderPage();

    const strategy = container.querySelector(
      'select[aria-label="Provider strategy for Single Engineer"]',
    ) as HTMLSelectElement;
    expect(strategy.querySelector('option[value="codex_then_claude"]')?.hasAttribute("disabled")).toBe(false);

    await act(async () => {
      strategy.value = "codex_then_claude";
      strategy.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await waitFor(() => expect(agentAssignmentsApiMock.update).toHaveBeenCalledTimes(1));
    expect(agentAssignmentsApiMock.update.mock.calls[0]?.[2]).toMatchObject({
      strategy: "failover",
      claude: { mode: "host", accountId: null },
    });
  });

  it("keeps non-subscription adapters read only and flags invalid legacy order", async () => {
    const processAgent = {
      ...singleAgent,
      id: "process-agent",
      name: "Deploy Script",
      adapterType: "process",
    };
    const legacyAgent = {
      ...dualAgent,
      id: "legacy-agent",
      name: "Legacy Agent",
      runtimeConfig: {
        subscriptionFailover: {
          enabled: true,
          order: ["claude_local", "claude_local"],
        },
      },
    };
    agentAssignmentsApiMock.list.mockResolvedValue({
      assignments: [
        { agent: processAgent, assignmentVersion: "process-v1" },
        { agent: legacyAgent, assignmentVersion: "legacy-v1" },
      ],
    });
    await renderPage();

    const processStrategy = container.querySelector(
      'select[aria-label="Provider strategy for Deploy Script"]',
    ) as HTMLSelectElement;
    const legacyStrategy = container.querySelector(
      'select[aria-label="Provider strategy for Legacy Agent"]',
    ) as HTMLSelectElement;
    expect(processStrategy.disabled).toBe(true);
    expect(processStrategy.value).toBe("other");
    expect(legacyStrategy.value).toBe("legacy_invalid");
    expect(legacyStrategy.disabled).toBe(false);
    expect(container.textContent).toContain("legacy failover order is invalid");
  });

  it("keeps Codex controls available when Claude overview fails", async () => {
    agentAssignmentsApiMock.list.mockResolvedValue({
      assignments: [{ agent: singleAgent, assignmentVersion: "single-v1" }],
    });
    claudeApiMock.list.mockRejectedValue(new Error("Claude unavailable"));
    await renderPage();

    const strategy = container.querySelector(
      'select[aria-label="Provider strategy for Single Engineer"]',
    ) as HTMLSelectElement;
    const codexAccount = container.querySelector(
      'select[aria-label="Codex account for Single Engineer"]',
    ) as HTMLSelectElement;
    expect(container.textContent).toContain("Claude accounts could not be loaded");
    expect(strategy.disabled).toBe(false);
    expect(codexAccount.disabled).toBe(false);
    expect(strategy.querySelector('option[value="claude_only"]')?.hasAttribute("disabled")).toBe(true);
  });

  it("disables an atomic dual edit when the other provider overview is unavailable", async () => {
    codexApiMock.list.mockRejectedValue(new Error("Codex unavailable"));
    await renderPage();

    const claudeAccount = container.querySelector(
      'select[aria-label="Claude account for Dual Delivery"]',
    ) as HTMLSelectElement;
    const strategy = container.querySelector(
      'select[aria-label="Provider strategy for Dual Delivery"]',
    ) as HTMLSelectElement;
    expect(claudeAccount.disabled).toBe(true);
    expect(strategy.querySelector('option[value="claude_only"]')?.hasAttribute("disabled")).toBe(false);
  });

  it("tracks pending state per row", async () => {
    let resolveUpdate!: (value: unknown) => void;
    agentAssignmentsApiMock.update.mockImplementation(() => new Promise((resolve) => {
      resolveUpdate = resolve;
    }));
    await renderPage();
    const dualStrategy = container.querySelector(
      'select[aria-label="Provider strategy for Dual Delivery"]',
    ) as HTMLSelectElement;
    const singleStrategy = container.querySelector(
      'select[aria-label="Provider strategy for Single Engineer"]',
    ) as HTMLSelectElement;

    await act(async () => {
      dualStrategy.value = "claude_then_codex";
      dualStrategy.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await waitFor(() => expect(dualStrategy.disabled).toBe(true));
    expect(singleStrategy.disabled).toBe(false);

    await act(async () => {
      resolveUpdate({ agent: dualAgent, assignmentVersion: "dual-v2" });
      await Promise.resolve();
    });
    await waitFor(() => expect(dualStrategy.disabled).toBe(false));
  });

  it("refetches and reports a row-local version conflict", async () => {
    agentAssignmentsApiMock.update.mockRejectedValue(new ApiError(
      "conflict",
      409,
      { code: "agent_assignment_version_conflict" },
    ));
    await renderPage();
    const initialVersionLoads = agentAssignmentsApiMock.list.mock.calls.length;
    const claudeAccount = container.querySelector(
      'select[aria-label="Claude account for Dual Delivery"]',
    ) as HTMLSelectElement;

    await act(async () => {
      claudeAccount.value = "claude-account-2";
      claudeAccount.dispatchEvent(new Event("change", { bubbles: true }));
    });

    await waitFor(() => {
      expect(container.querySelector('[role="alert"]')?.textContent).toContain("changed elsewhere");
      expect(agentAssignmentsApiMock.list.mock.calls.length).toBeGreaterThan(initialVersionLoads);
    });
  });

  it("does not mislabel other 409 responses as version conflicts", async () => {
    agentAssignmentsApiMock.update.mockRejectedValue(new ApiError(
      "Authenticate at least one account",
      409,
      { code: "account_not_authenticated" },
    ));
    await renderPage();
    const initialVersionLoads = agentAssignmentsApiMock.list.mock.calls.length;
    const claudeAccount = container.querySelector(
      'select[aria-label="Claude account for Dual Delivery"]',
    ) as HTMLSelectElement;

    await act(async () => {
      claudeAccount.value = "claude-account-2";
      claudeAccount.dispatchEvent(new Event("change", { bubbles: true }));
    });

    await waitFor(() => expect(container.querySelector('[role="alert"]')?.textContent)
      .toContain("Authenticate at least one account"));
    expect(agentAssignmentsApiMock.list.mock.calls.length).toBe(initialVersionLoads);
  });
});
