import { useEffect, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, Link2, Loader2 } from "lucide-react";
import type {
  Agent,
  AgentRuntimeConfig,
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
const BOTH_PROVIDERS_VALUE = "both";

type SubscriptionProvider = "codex_local" | "claude_local";
type ProviderSelection = SubscriptionProvider | typeof BOTH_PROVIDERS_VALUE;

function isSubscriptionProvider(value: string): value is SubscriptionProvider {
  return value === "codex_local" || value === "claude_local";
}

function readFailoverEnabled(agent: Agent): boolean {
  return agent.runtimeConfig?.subscriptionFailover?.enabled === true;
}

function providerSelection(agent: Agent): ProviderSelection | "other" {
  if (readFailoverEnabled(agent)) return BOTH_PROVIDERS_VALUE;
  if (isSubscriptionProvider(agent.adapterType)) return agent.adapterType;
  return "other";
}

function providerLabel(provider: string) {
  if (provider === "codex_local") return "Codex";
  if (provider === "claude_local") return "Claude";
  if (provider === BOTH_PROVIDERS_VALUE) return "Todos (Codex + Claude)";
  return provider;
}

function accountAssignmentValue(
  mode: Agent["codexAccountMode"] | Agent["claudeAccountMode"] | undefined,
  accountId: string | null | undefined,
): string {
  if (mode === "first_available") return FIRST_AVAILABLE_VALUE;
  if (mode === "fixed") return accountId ?? "";
  return "";
}

function codexAssignmentValue(agent: Agent): string {
  return accountAssignmentValue(agent.codexAccountMode, agent.codexAccountId);
}

function claudeAssignmentValue(agent: Agent): string {
  return accountAssignmentValue(agent.claudeAccountMode, agent.claudeAccountId);
}

function assignmentValue(agent: Agent): string {
  if (readFailoverEnabled(agent)) return codexAssignmentValue(agent);
  if (agent.adapterType === "codex_local") return codexAssignmentValue(agent);
  if (agent.adapterType === "claude_local") return claudeAssignmentValue(agent);
  return "";
}

function parseAssignment(value: string): CodexAccountAssignment | ClaudeAccountAssignment {
  if (value === FIRST_AVAILABLE_VALUE) return { mode: "first_available", accountId: null };
  if (value) return { mode: "fixed", accountId: value };
  return { mode: "host", accountId: null };
}

function mergeRuntimeConfig(
  agent: Agent,
  subscriptionFailover: AgentRuntimeConfig["subscriptionFailover"] | null,
): AgentRuntimeConfig {
  const next = { ...(agent.runtimeConfig ?? {}) };
  if (subscriptionFailover) {
    next.subscriptionFailover = subscriptionFailover;
  } else {
    delete next.subscriptionFailover;
  }
  return next;
}

function renderAccountSelect(input: {
  label: string;
  value: string;
  disabled: boolean;
  accounts: Array<{ id: string; name: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <select
      aria-label={input.label}
      className="rounded-md border border-border bg-background px-2.5 py-1.5 text-sm outline-none sm:w-80"
      value={input.value}
      disabled={input.disabled}
      onChange={(event) => input.onChange(event.target.value)}
    >
      <option value="">Host account (shared session)</option>
      <option value={FIRST_AVAILABLE_VALUE}>First available account (automatic)</option>
      {input.accounts.map((account) => (
        <option key={account.id} value={account.id}>
          {account.name}
        </option>
      ))}
    </select>
  );
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
    mutationFn: async ({ agent, provider }: { agent: Agent; provider: ProviderSelection }) => {
      const companyId = selectedCompanyId!;
      const current = providerSelection(agent);

      if (provider === BOTH_PROVIDERS_VALUE) {
        if (current !== BOTH_PROVIDERS_VALUE) {
          await agentsApi.update(
            agent.id,
            buildAgentUpdatePatch(agent, {
              identity: {},
              adapterType: "codex_local",
              adapterConfig: {},
              heartbeat: {},
              runtime: {
                runtimeConfig: mergeRuntimeConfig(agent, {
                  enabled: true,
                  order: ["codex_local", "claude_local"],
                }),
              },
            }),
            companyId,
          );
        }
        await codexAccountsApi.assignAgent(companyId, agent.id, {
          mode: "first_available",
          accountId: null,
        });
        return claudeAccountsApi.assignAgent(companyId, agent.id, {
          mode: "first_available",
          accountId: null,
        });
      }

      if (readFailoverEnabled(agent)) {
        await agentsApi.update(
          agent.id,
          buildAgentUpdatePatch(agent, {
            identity: {},
            runtime: {
              runtimeConfig: mergeRuntimeConfig(agent, null),
            },
            adapterConfig: {},
            heartbeat: {},
          }),
          companyId,
        );
        if (provider === "codex_local") {
          await claudeAccountsApi.assignAgent(companyId, agent.id, {
            mode: "host",
            accountId: null,
          });
        } else {
          await codexAccountsApi.assignAgent(companyId, agent.id, {
            mode: "host",
            accountId: null,
          });
        }
      } else if (isSubscriptionProvider(agent.adapterType)) {
        if (agent.adapterType === "codex_local" && provider === "claude_local") {
          await codexAccountsApi.assignAgent(companyId, agent.id, {
            mode: "host",
            accountId: null,
          });
        } else if (agent.adapterType === "claude_local" && provider === "codex_local") {
          await claudeAccountsApi.assignAgent(companyId, agent.id, {
            mode: "host",
            accountId: null,
          });
        }
      }

      if (agent.adapterType !== provider) {
        await agentsApi.update(
          agent.id,
          buildAgentUpdatePatch(agent, {
            identity: {},
            adapterType: provider,
            adapterConfig: {},
            heartbeat: {},
            runtime: {},
          }),
          companyId,
        );
      }

      if (provider === "codex_local") {
        return codexAccountsApi.assignAgent(companyId, agent.id, {
          mode: "first_available",
          accountId: null,
        });
      }
      return claudeAccountsApi.assignAgent(companyId, agent.id, {
        mode: "first_available",
        accountId: null,
      });
    },
    onSuccess: invalidate,
  });

  const assignmentMutation = useMutation({
    mutationFn: async ({
      agent,
      provider,
      value,
    }: {
      agent: Agent;
      provider: "codex_local" | "claude_local";
      value: string;
    }) => {
      const assignment = parseAssignment(value);
      if (provider === "codex_local") {
        return codexAccountsApi.assignAgent(selectedCompanyId!, agent.id, assignment);
      }
      return claudeAccountsApi.assignAgent(selectedCompanyId!, agent.id, assignment);
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
            Choose Codex, Claude, or both with automatic quota failover. Pick host session, first-available, or a fixed authenticated account for each provider.
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
        . Todos uses Codex first, then Claude when quota runs out. Switching provider mid-run starts a fresh session.
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
              const selection = providerSelection(agent);
              const failoverEnabled = selection === BOTH_PROVIDERS_VALUE;
              const subscriptionProvider = failoverEnabled
                ? null
                : isSubscriptionProvider(agent.adapterType)
                  ? agent.adapterType
                  : null;
              const codexMeta = codexMetaById.get(agent.id);
              const claudeMeta = claudeMetaById.get(agent.id);
              const canUseCodex = failoverEnabled
                ? (codexMeta?.canUse ?? true)
                : subscriptionProvider === "codex_local"
                  ? (codexMeta?.canUse ?? true)
                  : false;
              const canUseClaude = failoverEnabled
                ? (claudeMeta?.canUse ?? true)
                : subscriptionProvider === "claude_local"
                  ? (claudeMeta?.canUse ?? true)
                  : false;
              const blocker = failoverEnabled
                ? [codexMeta?.blocker, claudeMeta?.blocker].filter(Boolean).join(" · ") || null
                : (subscriptionProvider === "codex_local" ? codexMeta?.blocker : claudeMeta?.blocker)
                  ?? (!subscriptionProvider && !failoverEnabled
                    ? "Switch provider to Codex, Claude, or Todos to assign subscription accounts."
                    : null);
              const statusLabel = failoverEnabled
                ? "Todos (Codex + Claude)"
                : subscriptionProvider
                  ? providerLabel(subscriptionProvider)
                  : providerLabel(agent.adapterType);

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
                        {blocker ?? `${statusLabel} · ${agent.status}`}
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:flex-wrap sm:justify-end">
                    <select
                      aria-label={`Provider for ${agent.name}`}
                      className="rounded-md border border-border bg-background px-2.5 py-1.5 text-sm outline-none sm:w-52"
                      value={selection}
                      disabled={busy}
                      onChange={(event) => {
                        const value = event.target.value;
                        if (value !== BOTH_PROVIDERS_VALUE && !isSubscriptionProvider(value)) return;
                        providerMutation.mutate({
                          agent,
                          provider: value as ProviderSelection,
                        });
                      }}
                    >
                      {selection === "other" ? (
                        <option value="other">{providerLabel(agent.adapterType)}</option>
                      ) : null}
                      <option value="codex_local">Codex</option>
                      <option value="claude_local">Claude</option>
                      <option value={BOTH_PROVIDERS_VALUE}>Todos (Codex + Claude)</option>
                    </select>
                    {failoverEnabled ? (
                      <>
                        {renderAccountSelect({
                          label: `Codex account for ${agent.name}`,
                          value: codexAssignmentValue(agent),
                          disabled: !canUseCodex || busy,
                          accounts: authenticatedCodex,
                          onChange: (value) => {
                            assignmentMutation.mutate({ agent, provider: "codex_local", value });
                          },
                        })}
                        {renderAccountSelect({
                          label: `Claude account for ${agent.name}`,
                          value: claudeAssignmentValue(agent),
                          disabled: !canUseClaude || busy,
                          accounts: authenticatedClaude,
                          onChange: (value) => {
                            assignmentMutation.mutate({ agent, provider: "claude_local", value });
                          },
                        })}
                      </>
                    ) : (
                      renderAccountSelect({
                        label: `Account for ${agent.name}`,
                        value: assignmentValue(agent),
                        disabled: !subscriptionProvider || !(canUseCodex || canUseClaude) || busy,
                        accounts: subscriptionProvider === "codex_local" ? authenticatedCodex : authenticatedClaude,
                        onChange: (value) => {
                          if (!subscriptionProvider) return;
                          assignmentMutation.mutate({ agent, provider: subscriptionProvider, value });
                        },
                      })
                    )}
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
