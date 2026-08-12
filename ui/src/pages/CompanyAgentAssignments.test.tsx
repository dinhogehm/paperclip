// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyAgentAssignments } from "./CompanyAgentAssignments";

const agentsApiMock = vi.hoisted(() => ({ list: vi.fn(), update: vi.fn() }));
const codexApiMock = vi.hoisted(() => ({ list: vi.fn(), assignAgent: vi.fn() }));
const claudeApiMock = vi.hoisted(() => ({ list: vi.fn(), assignAgent: vi.fn() }));

vi.mock("@/api/agents", () => ({ agentsApi: agentsApiMock }));
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

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void>;
  flushSync(() => { result = callback(); });
  await result!;
}

async function waitFor(assertion: () => void) {
  let lastError: unknown;
  for (let index = 0; index < 20; index += 1) {
    await act(async () => {
      await Promise.resolve();
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

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    agentsApiMock.list.mockResolvedValue([
      {
        id: "codex-agent",
        name: "Delivery",
        status: "paused",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
        codexAccountMode: "first_available",
        codexAccountId: null,
        claudeAccountMode: "host",
        claudeAccountId: null,
      },
      {
        id: "claude-agent",
        name: "Reviewer",
        status: "paused",
        adapterType: "claude_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
        codexAccountMode: "host",
        codexAccountId: null,
        claudeAccountMode: "fixed",
        claudeAccountId: "claude-account",
      },
    ]);
    codexApiMock.list.mockResolvedValue({
      accounts: [{ id: "codex-account", name: "Codex Pro", authenticated: true }],
      agents: [{
        id: "codex-agent",
        canUseSubscriptionAccount: true,
        subscriptionAccountBlocker: null,
      }],
    });
    claudeApiMock.list.mockResolvedValue({
      accounts: [{ id: "claude-account", name: "Claude Max", authenticated: true }],
      agents: [{
        id: "claude-agent",
        canUseSubscriptionAccount: true,
        subscriptionAccountBlocker: null,
      }],
    });
    codexApiMock.assignAgent.mockResolvedValue({ id: "codex-agent" });
    claudeApiMock.assignAgent.mockResolvedValue({ id: "claude-agent" });
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("centralizes provider and account assignment controls", async () => {
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <CompanyAgentAssignments />
        </QueryClientProvider>,
      );
    });

    await waitFor(() => expect(container.textContent).toContain("Delivery"));
    expect(container.textContent).toContain("Reviewer");
    expect(container.querySelector('a[href="/company/settings/codex-accounts"]')).not.toBeNull();
    expect(container.querySelector('a[href="/company/settings/claude-accounts"]')).not.toBeNull();

    const deliveryAccount = container.querySelector(
      'select[aria-label="Account for Delivery"]',
    ) as HTMLSelectElement;
    expect(deliveryAccount.value).toBe("__first_available__");
    expect(Array.from(deliveryAccount.options).map((option) => option.textContent)).toContain("Codex Pro");

    const reviewerAccount = container.querySelector(
      'select[aria-label="Account for Reviewer"]',
    ) as HTMLSelectElement;
    expect(reviewerAccount.value).toBe("claude-account");
    expect(Array.from(reviewerAccount.options).map((option) => option.textContent)).toContain("Claude Max");

    await act(async () => {
      deliveryAccount.value = "codex-account";
      deliveryAccount.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await waitFor(() => expect(codexApiMock.assignAgent).toHaveBeenCalledWith(
      "company-1",
      "codex-agent",
      { mode: "fixed", accountId: "codex-account" },
    ));

    await act(async () => root.unmount());
  });
});
