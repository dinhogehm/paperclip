import { useEffect, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, Link2, Loader2 } from "lucide-react";
import type {
  Agent,
  ClaudeAccountAssignment,
  CodexAccountAssignment,
} from "@paperclipai/shared";
import { agentsApi } from "@/api/agents";
import { claudeAccountsApi } from "@/api/claudeAccounts";
import { codexAccountsApi } from "@/api/codexAccounts";
import { buildAgentUpdatePatch } from "@/lib/agent-config-patch";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { queryKeys } from "@/lib/queryKeys";

const FIRST_AVAILABLE_VALUE = "__first_available__";

type SubscriptionProvider = "codex_local" | "claude_local";

function isSubscriptionProvider(value: string): value is SubscriptionProvider {
  return value === "codex_local" || value === "claude_local";
}

function providerLabel(provider: string) {
  if (provider === "codex_local") return "Codex";
  if (provider === "claude_local") return "Claude";
  return provider;
}

function assignmentValue(agent: Agent): string {
  if (agent.adapterType === "codex_local") {
    if (agent.codexAccountMode === "first_available") return FIRST_AVAILABLE_VALUE;
    if (agent.codexAccountMode === "fixed") return agent.codexAccountId ?? "";
    return "";
  }
  if (agent.adapterType === "claude_local") {
    if (agent.claudeAccountMode === "first_available") return FIRST_AVAILABLE_VALUE;
    if (agent.claudeAccountMode === "fixed") return agent.claudeAccountId ?? "";
    return "";
  }
  return "";
}

function parseAssignment(value: string): CodexAccountAssignment | ClaudeAccountAssignment {
  if (value === FIRST_AVAILABLE_VALUE) return { mode: "first_available", accountId: null };
  if (value) return { mode: "fixed", accountId: value };
  return { mode: "host", accountId: null };
}

export function CompanyAgentAssignments() {
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? "Company", href: "/dashboard" },
      { label: "Settings", href: "/company/settings" },
      { label: "Agent assignments" },
    ]);
  }, [selectedCompany?.name, setBreadcrumbs]);

  const agentsQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.agents.list(selectedCompanyId) : ["agents", "__disabled__"],
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });
  const codexQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.codexAccounts.list(selectedCompanyId) : ["codex-accounts", "__disabled__"],
    queryFn: () => codexAccountsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });
  const claudeQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.claudeAccounts.list(selectedCompanyId) : ["claude-accounts", "__disabled__"],
    queryFn: () => claudeAccountsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  const invalidate = async () => {
    if (!selectedCompanyId) return;
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(selectedCompanyId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.codexAccounts.list(selectedCompanyId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.claudeAccounts.list(selectedCompanyId) }),
    ]);
  };

  const agents = useMemo(
    () => (agentsQuery.data ?? [])
      .filter((agent) => agent.status !== "terminated")
      .slice()
      .sort((left, right) => left.name.localeCompare(right.name)),
    [agentsQuery.data],
  );

  const codexMetaById = useMemo(() => {
    const map = new Map<string, { canUse: boolean; blocker: string | null }>();
    for (const agent of codexQuery.data?.agents ?? []) {
      map.set(agent.id, {
        canUse: agent.canUseSubscriptionAccount,
        blocker: agent.subscriptionAccountBlocker,
      });
    }
    return map;
  }, [codexQuery.data?.agents]);

  const claudeMetaById = useMemo(() => {
    const map = new Map<string, { canUse: boolean; blocker: string | null }>();
    for (const agent of claudeQuery.data?.agents ?? []) {
      map.set(agent.id, {
        canUse: agent.canUseSubscriptionAccount,
        blocker: agent.subscriptionAccountBlocker,
      });
    }
    return map;
  }, [claudeQuery.data?.agents]);

  const authenticatedCodex = useMemo(
    () => codexQuery.data?.accounts.filter((account) => account.authenticated) ?? [],
    [codexQuery.data?.accounts],
  );
  const authenticatedClaude = useMemo(
    () => claudeQuery.data?.accounts.filter((account) => account.authenticated) ?? [],
    [claudeQuery.data?.accounts],
  );

  const providerMutation = useMutation({
    mutationFn: async ({ agent, provider }: { agent: Agent; provider: SubscriptionProvider }) => {
      if (agent.adapterType === provider) return agent;
      if (isSubscriptionProvider(agent.adapterType)) {
        if (agent.adapterType === "codex_local") {
          await codexAccountsApi.assignAgent(selectedCompanyId!, agent.id, {
            mode: "host",
            accountId: null,
          });
        } else {
          await claudeAccountsApi.assignAgent(selectedCompanyId!, agent.id, {
            mode: "host",
            accountId: null,
          });
        }
      }
      await agentsApi.update(
        agent.id,
        buildAgentUpdatePatch(agent, {
          identity: {},
          adapterType: provider,
          adapterConfig: {},
          heartbeat: {},
          runtime: {},
        }),
        selectedCompanyId!,
      );
      if (provider === "codex_local") {
        return codexAccountsApi.assignAgent(selectedCompanyId!, agent.id, {
          mode: "first_available",
          accountId: null,
        });
      }
      return claudeAccountsApi.assignAgent(selectedCompanyId!, agent.id, {
        mode: "first_available",
        accountId: null,
      });
    },
    onSuccess: invalidate,
  });

  const assignmentMutation = useMutation({
    mutationFn: async ({
      agent,
      value,
    }: {
      agent: Agent;
      value: string;
    }) => {
      const assignment = parseAssignment(value);
      if (agent.adapterType === "codex_local") {
        return codexAccountsApi.assignAgent(selectedCompanyId!, agent.id, assignment);
      }
      if (agent.adapterType === "claude_local") {
        return claudeAccountsApi.assignAgent(selectedCompanyId!, agent.id, assignment);
      }
      throw new Error("Switch this agent to Codex or Claude before assigning an account");
    },
    onSuccess: invalidate,
  });

  if (!selectedCompanyId || !selectedCompany) {
    return <div className="text-sm text-muted-foreground">Select a company to manage agent assignments.</div>;
  }

  const loading = agentsQuery.isPending || codexQuery.isPending || claudeQuery.isPending;
  const error = agentsQuery.error ?? codexQuery.error ?? claudeQuery.error;
  const busy = providerMutation.isPending || assignmentMutation.isPending;

  return (
    <div className="max-w-4xl space-y-6">
      <div className="flex items-start gap-3">
        <div className="rounded-md border border-border bg-muted/40 p-2">
          <Link2 className="h-5 w-5 text-muted-foreground" />
        </div>
        <div>
          <h1 className="text-lg font-semibold">Agent assignments</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Choose which agents run on Codex or Claude, then pick a host session, automatic first-available account, or a fixed authenticated account.
          </p>
        </div>
      </div>

      <div className="rounded-md border border-border bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
        Manage logins in{" "}
        <Link className="underline underline-offset-2 hover:text-foreground" to="/company/settings/codex-accounts">
          Codex accounts
        </Link>
        {" "}and{" "}
        <Link className="underline underline-offset-2 hover:text-foreground" to="/company/settings/claude-accounts">
          Claude accounts
        </Link>
        . Switching provider here updates the agent adapter and clears the previous subscription assignment.
      </div>

      <section className="space-y-3" aria-labelledby="agent-assignments-heading">
        <div className="flex items-center justify-between gap-3">
          <h2 id="agent-assignments-heading" className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Agents
          </h2>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              void agentsQuery.refetch();
              void codexQuery.refetch();
              void claudeQuery.refetch();
            }}
            disabled={busy || agentsQuery.isFetching}
          >
            {agentsQuery.isFetching ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
            Refresh
          </Button>
        </div>

        {loading ? (
          <div className="flex items-center gap-2 rounded-md border border-border p-4 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading agents…
          </div>
        ) : error ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
            {error.message}
          </div>
        ) : agents.length === 0 ? (
          <div className="rounded-md border border-dashed border-border p-5 text-sm text-muted-foreground">
            No active agents in this company.
          </div>
        ) : (
          <div className="divide-y divide-border rounded-md border border-border">
            {agents.map((agent) => {
              const subscriptionProvider = isSubscriptionProvider(agent.adapterType) ? agent.adapterType : null;
              const meta = subscriptionProvider === "codex_local"
                ? codexMetaById.get(agent.id)
                : subscriptionProvider === "claude_local"
                  ? claudeMetaById.get(agent.id)
                  : undefined;
              const canUse = subscriptionProvider
                ? (meta?.canUse ?? true)
                : false;
              const blocker = meta?.blocker
                ?? (!subscriptionProvider
                  ? "Switch provider to Codex or Claude to assign a subscription account."
                  : null);
              const accounts = subscriptionProvider === "codex_local"
                ? authenticatedCodex
                : subscriptionProvider === "claude_local"
                  ? authenticatedClaude
                  : [];

              return (
                <div
                  key={agent.id}
                  className="flex flex-col gap-3 p-4 lg:flex-row lg:items-center lg:justify-between"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <Bot className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{agent.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {blocker ?? `${providerLabel(agent.adapterType)} · ${agent.status}`}
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                    <select
                      aria-label={`Provider for ${agent.name}`}
                      className="rounded-md border border-border bg-background px-2.5 py-1.5 text-sm outline-none sm:w-40"
                      value={subscriptionProvider ?? "other"}
                      disabled={busy}
                      onChange={(event) => {
                        const value = event.target.value;
                        if (!isSubscriptionProvider(value)) return;
                        providerMutation.mutate({ agent, provider: value });
                      }}
                    >
                      {!subscriptionProvider ? (
                        <option value="other">{providerLabel(agent.adapterType)}</option>
                      ) : null}
                      <option value="codex_local">Codex</option>
                      <option value="claude_local">Claude</option>
                    </select>
                    <select
                      aria-label={`Account for ${agent.name}`}
                      className="rounded-md border border-border bg-background px-2.5 py-1.5 text-sm outline-none sm:w-80"
                      value={assignmentValue(agent)}
                      disabled={!subscriptionProvider || !canUse || busy}
                      onChange={(event) => {
                        assignmentMutation.mutate({ agent, value: event.target.value });
                      }}
                    >
                      <option value="">Host account (shared session)</option>
                      <option value={FIRST_AVAILABLE_VALUE}>First available account (automatic)</option>
                      {accounts.map((account) => (
                        <option key={account.id} value={account.id}>
                          {account.name}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {providerMutation.isError ? (
          <p className="text-xs text-destructive">{providerMutation.error.message}</p>
        ) : null}
        {assignmentMutation.isError ? (
          <p className="text-xs text-destructive">{assignmentMutation.error.message}</p>
        ) : null}
      </section>
    </div>
  );
}
