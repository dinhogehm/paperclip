// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyCodexAccounts } from "./CompanyCodexAccounts";

const mockApi = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  startLogin: vi.fn(),
  assignAgent: vi.fn(),
  remove: vi.fn(),
}));
const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());

vi.mock("@/api/codexAccounts", () => ({ codexAccountsApi: mockApi }));
vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: mockSetBreadcrumbs }),
}));
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    selectedCompany: { id: "company-1", name: "NUR" },
  }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void>;
  flushSync(() => {
    result = callback();
  });
  await result!;
}

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

async function waitFor(assertion: () => void) {
  let lastError: unknown;
  for (let index = 0; index < 20; index += 1) {
    await flushReact();
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

describe("CompanyCodexAccounts", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockApi.list.mockResolvedValue({
      accounts: [
        {
          id: "account-1",
          companyId: "company-1",
          name: "Pro principal",
          authenticated: true,
          email: "owner@example.com",
          planType: "pro",
          lastRefresh: "2026-08-10T10:00:00.000Z",
          lastAuthenticatedAt: "2026-08-10T10:00:00.000Z",
          assignedAgentIds: ["agent-1"],
          login: {
            status: "authenticated",
            verificationUrl: null,
            userCode: null,
            startedAt: null,
            expiresAt: null,
            error: null,
          },
          createdAt: "2026-08-10T09:00:00.000Z",
          updatedAt: "2026-08-10T10:00:00.000Z",
        },
        {
          id: "account-2",
          companyId: "company-1",
          name: "Pro secundária",
          authenticated: false,
          email: null,
          planType: null,
          lastRefresh: null,
          lastAuthenticatedAt: null,
          assignedAgentIds: [],
          login: {
            status: "waiting_for_user",
            verificationUrl: "https://auth.openai.com/codex/device",
            userCode: "ABCD-EFGH",
            startedAt: "2026-08-10T12:00:00.000Z",
            expiresAt: "2026-08-10T12:15:00.000Z",
            error: null,
          },
          createdAt: "2026-08-10T12:00:00.000Z",
          updatedAt: "2026-08-10T12:00:00.000Z",
        },
      ],
      agents: [
        {
          id: "agent-1",
          name: "Engenheiro de Entrega",
          status: "idle",
          codexAccountId: "account-1",
          canUseSubscriptionAccount: true,
          subscriptionAccountBlocker: null,
        },
      ],
    });
    mockApi.startLogin.mockResolvedValue({
      status: "waiting_for_user",
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "IJKL-MNOP",
      startedAt: "2026-08-10T12:00:00.000Z",
      expiresAt: "2026-08-10T12:15:00.000Z",
      error: null,
    });
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("shows isolated accounts, device-code login, and agent assignment", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CompanyCodexAccounts />
        </QueryClientProvider>,
      );
    });
    await waitFor(() => expect(container.textContent).toContain("owner@example.com · pro"));

    expect(container.textContent).toContain("ABCD-EFGH");
    expect(container.querySelector('a[href="https://auth.openai.com/codex/device"]')).not.toBeNull();
    const assignment = container.querySelector(
      'select[aria-label="Codex account for Engenheiro de Entrega"]',
    ) as HTMLSelectElement | null;
    expect(assignment?.value).toBe("account-1");
    expect(Array.from(assignment?.options ?? []).map((option) => option.textContent)).toContain(
      "Pro principal",
    );
    expect(Array.from(assignment?.options ?? []).map((option) => option.textContent)).not.toContain(
      "Pro secundária",
    );

    const authenticate = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Reauthenticate",
    );
    await act(async () => {
      authenticate?.click();
    });
    await waitFor(() => expect(mockApi.startLogin).toHaveBeenCalledWith("company-1", "account-1"));

    await act(async () => root.unmount());
  });
});
