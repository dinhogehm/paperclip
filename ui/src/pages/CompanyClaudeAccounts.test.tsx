// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyClaudeAccounts } from "./CompanyClaudeAccounts";

const mockApi = vi.hoisted(() => ({
  list: vi.fn(), create: vi.fn(), startLogin: vi.fn(), assignAgent: vi.fn(), remove: vi.fn(),
}));
vi.mock("@/api/claudeAccounts", () => ({ claudeAccountsApi: mockApi }));
vi.mock("@/lib/router", () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => <a href={to}>{children}</a>,
}));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1", selectedCompany: { id: "company-1", name: "NUR" } }),
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
    await act(async () => { await Promise.resolve(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    try { assertion(); return; } catch (error) { lastError = error; }
  }
  throw lastError;
}

describe("CompanyClaudeAccounts", () => {
  let container: HTMLDivElement;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockApi.list.mockResolvedValue({
      accounts: [{
        id: "account-1", companyId: "company-1", name: "Claude Max", authenticated: true,
        authMethod: "claude.ai", planType: "max", lastAuthenticatedAt: null, assignedAgentIds: [],
        quota: { status: "available", fetchedAt: "2026-08-12T12:00:00.000Z", error: null, windows: [{ label: "Current week", usedPercent: 25, resetsAt: "2026-08-15T12:00:00.000Z", valueLabel: null, detail: null }] },
        login: { status: "authenticated", verificationUrl: null, startedAt: null, expiresAt: null, error: null },
        createdAt: "2026-08-12T10:00:00.000Z", updatedAt: "2026-08-12T10:00:00.000Z",
      }],
      agents: [{
        id: "agent-1", name: "Claude Engineer", status: "idle", claudeAccountMode: "host", claudeAccountId: null,
        canUseSubscriptionAccount: true, subscriptionAccountBlocker: null,
      }],
    });
    mockApi.assignAgent.mockResolvedValue({ id: "agent-1" });
  });
  afterEach(() => { container.remove(); document.body.innerHTML = ""; vi.clearAllMocks(); });

  it("shows quota without embedding agent assignments", async () => {
    const root = createRoot(container);
    await act(async () => root.render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><CompanyClaudeAccounts /></QueryClientProvider>));
    await waitFor(() => expect(container.textContent).toContain("75% available"));
    expect(container.textContent).not.toContain("Agent assignments");
    expect(container.querySelector('select[aria-label="Claude account for Claude Engineer"]')).toBeNull();
    await act(async () => root.unmount());
  });
});
