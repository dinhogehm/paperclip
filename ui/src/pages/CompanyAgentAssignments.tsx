import { useEffect, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Bot, Link2, Loader2 } from "lucide-react";
import type { Agent } from "@paperclipai/shared";
import {
  agentAssignmentsApi,
  type AgentAssignmentsOverview,
  type SubscriptionAccountAssignment,
  type SubscriptionProvider,
  type UpdateAgentAssignmentInput,
  type UpdateAgentAssignmentResponse,
} from "@/api/agentAssignments";
import { claudeAccountsApi } from "@/api/claudeAccounts";
import { ApiError } from "@/api/client";
import { codexAccountsApi } from "@/api/codexAccounts";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { queryKeys } from "@/lib/queryKeys";

const FIRST_AVAILABLE_VALUE = "__first_available__";
const NO_AUTHENTICATED_ACCOUNTS: ReadonlySet<string> = new Set();

type ProviderSelection =
  | "codex_only"
  | "claude_only"
  | "codex_then_claude"
  | "claude_then_codex";
type DisplaySelection = ProviderSelection | "other" | "legacy_invalid";

interface AccountOption {
  id: string;
  name: string;
  authenticated: boolean;
}

interface ProviderAccountState {
  accounts: AccountOption[];
  authenticatedIds: ReadonlySet<string>;
  ready: boolean;
  loading: boolean;
  error: string | null;
  blocker: string | null;
}

function isSubscriptionProvider(value: unknown): value is SubscriptionProvider {
  return value === "codex_local" || value === "claude_local";
}

function providerSelection(agent: Agent): DisplaySelection {
  const failoverValue = agent.runtimeConfig?.subscriptionFailover;
  const failover = failoverValue && typeof failoverValue === "object"
    ? failoverValue as { enabled?: boolean; order?: unknown[] }
    : null;
  if (failover?.enabled === true) {
    const order = failover.order;
    if (order?.length === 2 && order[0] === "codex_local" && order[1] === "claude_local") {
      return "codex_then_claude";
    }
    if (order?.length === 2 && order[0] === "claude_local" && order[1] === "codex_local") {
      return "claude_then_codex";
    }
    return "legacy_invalid";
  }
  if (agent.adapterType === "codex_local") return "codex_only";
  if (agent.adapterType === "claude_local") return "claude_only";
  return "other";
}

function selectionLabel(selection: DisplaySelection, fallback: string) {
  if (selection === "codex_only") return "Codex only";
  if (selection === "claude_only") return "Claude only";
  if (selection === "codex_then_claude") return "Codex → Claude";
  if (selection === "claude_then_codex") return "Claude → Codex";
  if (selection === "legacy_invalid") return "Invalid legacy failover";
  return fallback;
}

function providersForSelection(selection: DisplaySelection): SubscriptionProvider[] {
  if (selection === "codex_only") return ["codex_local"];
  if (selection === "claude_only") return ["claude_local"];
  if (selection === "codex_then_claude") return ["codex_local", "claude_local"];
  if (selection === "claude_then_codex") return ["claude_local", "codex_local"];
  return [];
}

function accountAssignment(
  mode: Agent["codexAccountMode"] | Agent["claudeAccountMode"] | undefined,
  accountId: string | null | undefined,
): SubscriptionAccountAssignment {
  if (mode === "first_available") return { mode: "first_available", accountId: null };
  if (mode === "fixed" && accountId) return { mode: "fixed", accountId };
  return { mode: "host", accountId: null };
}

function assignmentValue(assignment: SubscriptionAccountAssignment): string {
  if (assignment.mode === "first_available") return FIRST_AVAILABLE_VALUE;
  if (assignment.mode === "fixed") return assignment.accountId ?? "";
  return "";
}

function parseAssignment(value: string): SubscriptionAccountAssignment {
  if (value === FIRST_AVAILABLE_VALUE) return { mode: "first_available", accountId: null };
  if (value) return { mode: "fixed", accountId: value };
  return { mode: "host", accountId: null };
}

function normalizeNewProviderAssignment(
  assignment: SubscriptionAccountAssignment,
  authenticatedIds: ReadonlySet<string>,
): SubscriptionAccountAssignment {
  if (assignment.mode === "fixed" && assignment.accountId && authenticatedIds.has(assignment.accountId)) {
    return assignment;
  }
  if (assignment.mode === "first_available" && authenticatedIds.size > 0) return assignment;
  return authenticatedIds.size > 0
    ? { mode: "first_available", accountId: null }
    : { mode: "host", accountId: null };
}

function resolveAssignments(input: {
  agent: Agent;
  selection: ProviderSelection;
  authenticatedAccountIds: Record<SubscriptionProvider, ReadonlySet<string>>;
  override?: { provider: SubscriptionProvider; assignment: SubscriptionAccountAssignment };
}): { codex: SubscriptionAccountAssignment; claude: SubscriptionAccountAssignment } {
  const currentSelection = providerSelection(input.agent);
  const currentProviders = new Set(providersForSelection(currentSelection));
  const nextProviders = providersForSelection(input.selection);
  let codex = accountAssignment(input.agent.codexAccountMode, input.agent.codexAccountId);
  let claude = accountAssignment(input.agent.claudeAccountMode, input.agent.claudeAccountId);

  for (const provider of nextProviders) {
    if (currentProviders.has(provider)) continue;
    if (provider === "codex_local") {
      codex = normalizeNewProviderAssignment(codex, input.authenticatedAccountIds.codex_local);
    } else {
      claude = normalizeNewProviderAssignment(claude, input.authenticatedAccountIds.claude_local);
    }
  }

  if (input.override?.provider === "codex_local") codex = input.override.assignment;
  if (input.override?.provider === "claude_local") claude = input.override.assignment;

  return { codex, claude };
}

function buildAssignmentPayload(input: {
  agent: Agent;
  selection: ProviderSelection;
  assignmentVersion: string | null;
  authenticatedAccountIds: Record<SubscriptionProvider, ReadonlySet<string>>;
  override?: { provider: SubscriptionProvider; assignment: SubscriptionAccountAssignment };
}): UpdateAgentAssignmentInput {
  const { codex, claude } = resolveAssignments(input);
  const nextProviders = providersForSelection(input.selection);

  return {
    strategy: nextProviders.length === 2 ? "failover" : "single",
    preferredProvider: nextProviders[0]!,
    codex,
    claude,
    expectedAssignmentVersion: input.assignmentVersion,
  };
}

function isVersionConflict(error: unknown): boolean {
  if (error instanceof ApiError) {
    const body = error.body && typeof error.body === "object" && !Array.isArray(error.body)
      ? error.body as { code?: unknown }
      : null;
    return error.status === 409 && body?.code === "agent_assignment_version_conflict";
  }
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { status?: unknown; code?: unknown; body?: unknown };
  const body = candidate.body && typeof candidate.body === "object" && !Array.isArray(candidate.body)
    ? candidate.body as { code?: unknown }
    : null;
  return candidate.status === 409
    && (candidate.code === "agent_assignment_version_conflict"
      || body?.code === "agent_assignment_version_conflict");
}

function providerName(provider: SubscriptionProvider) {
  return provider === "codex_local" ? "Codex" : "Claude";
}

function AccountSelect(input: {
  provider: SubscriptionProvider;
  priorityLabel?: "Primary" | "Fallback";
  agentName: string;
  assignment: SubscriptionAccountAssignment;
  disabled: boolean;
  firstAvailableDisabled: boolean;
  managedAssignmentsDisabled: boolean;
  accounts: AccountOption[];
  message: string | null;
  messageDestructive?: boolean;
  onChange: (value: string) => void;
}) {
  const label = `${providerName(input.provider)} account for ${input.agentName}`;
  const assignedId = input.assignment.mode === "fixed" ? input.assignment.accountId : null;
  const accountExists = assignedId
    ? input.accounts.some((account) => account.id === assignedId)
    : true;
  const accounts = accountExists || !assignedId
    ? input.accounts
    : [{ id: assignedId, name: "Previously assigned account", authenticated: false }, ...input.accounts];

  return (
    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
      <span>
        {providerName(input.provider)} account
        {input.priorityLabel ? ` · ${input.priorityLabel}` : ""}
      </span>
      <select
        aria-label={label}
        className="rounded-md border border-border bg-background px-2.5 py-1.5 text-sm text-foreground outline-none sm:w-80"
        value={assignmentValue(input.assignment)}
        disabled={input.disabled}
        onChange={(event) => input.onChange(event.target.value)}
      >
        <option value="">Paperclip server host session (shared, not managed)</option>
        <option
          value={FIRST_AVAILABLE_VALUE}
          disabled={input.firstAvailableDisabled || input.managedAssignmentsDisabled}
        >
          {input.firstAvailableDisabled
            ? "First available account (authenticate an account first)"
            : "First available account (automatic)"}
        </option>
        {accounts.map((account) => (
          <option
            key={account.id}
            value={account.id}
            disabled={!account.authenticated || input.managedAssignmentsDisabled}
          >
            {account.name}{account.authenticated ? "" : " (not authenticated)"}
          </option>
        ))}
      </select>
      {input.message ? (
        <span className={input.messageDestructive ? "text-destructive" : "text-muted-foreground"}>
          {input.message}
        </span>
      ) : null}
    </label>
  );
}

function AgentAssignmentRow(input: {
  agent: Agent;
  companyId: string;
  assignmentVersion: string | null | undefined;
  codexState: ProviderAccountState;
  claudeState: ProviderAccountState;
  onSaved: (result: UpdateAgentAssignmentResponse) => Promise<void>;
  onConflict: () => Promise<void>;
}) {
  const { agent } = input;
  const selection = providerSelection(agent);
  const activeProviders = providersForSelection(selection);
  const isFailover = activeProviders.length === 2;
  const editableAdapter = isSubscriptionProvider(agent.adapterType);
  const hasAssignmentVersion = input.assignmentVersion !== undefined;
  const codex = accountAssignment(agent.codexAccountMode, agent.codexAccountId);
  const claude = accountAssignment(agent.claudeAccountMode, agent.claudeAccountId);

  const stateFor = (provider: SubscriptionProvider) => (
    provider === "codex_local" ? input.codexState : input.claudeState
  );
  const activationAccountIds = {
    codex_local: input.codexState.blocker === null
      ? input.codexState.authenticatedIds
      : NO_AUTHENTICATED_ACCOUNTS,
    claude_local: input.claudeState.blocker === null
      ? input.claudeState.authenticatedIds
      : NO_AUTHENTICATED_ACCOUNTS,
  } satisfies Record<SubscriptionProvider, ReadonlySet<string>>;
  const providerCanSave = (
    provider: SubscriptionProvider,
    assignment: SubscriptionAccountAssignment,
  ) => {
    const state = stateFor(provider);
    if (!state.ready) return false;
    if (assignment.mode === "host") return true;
    if (state.blocker !== null) return false;
    if (assignment.mode === "first_available") return state.authenticatedIds.size > 0;
    return assignment.accountId !== null && state.authenticatedIds.has(assignment.accountId);
  };
  const selectionCanSave = (
    candidate: ProviderSelection,
    override?: { provider: SubscriptionProvider; assignment: SubscriptionAccountAssignment },
  ) => {
    const assignments = resolveAssignments({
      agent,
      selection: candidate,
      authenticatedAccountIds: activationAccountIds,
      ...(override ? { override } : {}),
    });
    return providersForSelection(candidate).every((provider) => providerCanSave(
      provider,
      provider === "codex_local" ? assignments.codex : assignments.claude,
    ));
  };

  const mutation = useMutation({
    mutationFn: (payload: UpdateAgentAssignmentInput) =>
      agentAssignmentsApi.update(input.companyId, agent.id, payload),
    onSuccess: input.onSaved,
    onError: async (error) => {
      if (isVersionConflict(error)) await input.onConflict();
    },
  });

  const update = (
    nextSelection: ProviderSelection,
    override?: { provider: SubscriptionProvider; assignment: SubscriptionAccountAssignment },
  ) => {
    if (
      !editableAdapter
      || input.assignmentVersion === undefined
      || !selectionCanSave(nextSelection, override)
    ) return;
    mutation.mutate(buildAssignmentPayload({
      agent,
      selection: nextSelection,
      assignmentVersion: input.assignmentVersion,
      authenticatedAccountIds: activationAccountIds,
      ...(override ? { override } : {}),
    }));
  };

  const rowDisabled = mutation.isPending || !editableAdapter || !hasAssignmentVersion;
  const rowWarning = !editableAdapter
    ? "This agent uses a non-subscription adapter. Change its adapter from the agent configuration page."
    : selection === "legacy_invalid"
      ? "This legacy failover order is invalid. Select a valid strategy to repair it."
      : !hasAssignmentVersion
        ? "Assignment version is unavailable. Refresh before editing this agent."
        : null;

  return (
    <div className="flex flex-col gap-4 p-4" aria-busy={mutation.isPending}>
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 items-center gap-2">
          <Bot className="h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{agent.name}</p>
            <p className="text-xs text-muted-foreground">
              {selectionLabel(selection, agent.adapterType)} · {agent.status}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {mutation.isPending ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /> : null}
          <select
            aria-label={`Provider strategy for ${agent.name}`}
            className="rounded-md border border-border bg-background px-2.5 py-1.5 text-sm outline-none sm:w-56"
            value={selection}
            disabled={rowDisabled}
            onChange={(event) => {
              const value = event.target.value as ProviderSelection;
              if (!providersForSelection(value).length) return;
              update(value);
            }}
          >
            {selection === "other" ? <option value="other">{agent.adapterType} (read only)</option> : null}
            {selection === "legacy_invalid" ? (
              <option value="legacy_invalid">Invalid legacy failover (repair required)</option>
            ) : null}
            <option value="codex_only" disabled={!selectionCanSave("codex_only")}>Codex only</option>
            <option value="claude_only" disabled={!selectionCanSave("claude_only")}>Claude only</option>
            <option value="codex_then_claude" disabled={!selectionCanSave("codex_then_claude")}>
              Codex → Claude
            </option>
            <option value="claude_then_codex" disabled={!selectionCanSave("claude_then_codex")}>
              Claude → Codex
            </option>
          </select>
        </div>
      </div>

      {rowWarning ? (
        <p className="flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-300">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          {rowWarning}
        </p>
      ) : null}

      {activeProviders.length > 0 ? (
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:justify-end">
          {activeProviders.map((provider, index) => {
            const state = stateFor(provider);
            const assignment = provider === "codex_local" ? codex : claude;
            const canSaveHostForProvider = (
              selection === "codex_only"
              || selection === "claude_only"
              || selection === "codex_then_claude"
              || selection === "claude_then_codex"
            ) && selectionCanSave(selection, {
              provider,
              assignment: { mode: "host", accountId: null },
            });
            const providerMessage = state.blocker
              ?? state.error
              ?? (state.loading
                ? `Loading ${providerName(provider)} accounts…`
                : state.authenticatedIds.size === 0
                  ? `No authenticated ${providerName(provider)} account. Automatic selection is unavailable.`
                  : null);
            return (
              <AccountSelect
                key={provider}
                provider={provider}
                priorityLabel={isFailover ? (index === 0 ? "Primary" : "Fallback") : undefined}
                agentName={agent.name}
                assignment={assignment}
                disabled={rowDisabled || !state.ready || !canSaveHostForProvider}
                firstAvailableDisabled={state.authenticatedIds.size === 0}
                managedAssignmentsDisabled={state.blocker !== null}
                accounts={state.accounts}
                message={providerMessage}
                messageDestructive={state.blocker !== null || state.error !== null}
                onChange={(value) => update(selection as ProviderSelection, {
                  provider,
                  assignment: parseAssignment(value),
                })}
              />
            );
          })}
        </div>
      ) : null}

      {mutation.isError ? (
        <p className="text-xs text-destructive" role="alert">
          {isVersionConflict(mutation.error)
            ? "This assignment changed elsewhere. The latest values were reloaded; review and try again."
            : mutation.error.message}
        </p>
      ) : null}
    </div>
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

  const assignmentsQuery = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.agentAssignments.list(selectedCompanyId)
      : ["agent-assignments", "__disabled__"],
    queryFn: () => agentAssignmentsApi.list(selectedCompanyId!),
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

  const assignmentSnapshots = useMemo(
    () => (assignmentsQuery.data?.assignments ?? [])
      .filter(({ agent }) => agent.status !== "terminated")
      .slice()
      .sort((left, right) => left.agent.name.localeCompare(right.agent.name)),
    [assignmentsQuery.data?.assignments],
  );
  const codexMeta = useMemo(
    () => new Map((codexQuery.data?.agents ?? []).map((agent) => [agent.id, agent])),
    [codexQuery.data?.agents],
  );
  const claudeMeta = useMemo(
    () => new Map((claudeQuery.data?.agents ?? []).map((agent) => [agent.id, agent])),
    [claudeQuery.data?.agents],
  );
  const codexAccounts = useMemo<AccountOption[]>(
    () => (codexQuery.data?.accounts ?? []).map(({ id, name, authenticated }) => ({ id, name, authenticated })),
    [codexQuery.data?.accounts],
  );
  const claudeAccounts = useMemo<AccountOption[]>(
    () => (claudeQuery.data?.accounts ?? []).map(({ id, name, authenticated }) => ({ id, name, authenticated })),
    [claudeQuery.data?.accounts],
  );
  const authenticatedCodexIds = useMemo(
    () => new Set(codexAccounts.filter((account) => account.authenticated).map((account) => account.id)),
    [codexAccounts],
  );
  const authenticatedClaudeIds = useMemo(
    () => new Set(claudeAccounts.filter((account) => account.authenticated).map((account) => account.id)),
    [claudeAccounts],
  );

  const refreshAll = async () => {
    if (!selectedCompanyId) return;
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(selectedCompanyId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.agentAssignments.list(selectedCompanyId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.codexAccounts.list(selectedCompanyId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.claudeAccounts.list(selectedCompanyId) }),
    ]);
  };

  const applySavedResult = async (result: UpdateAgentAssignmentResponse) => {
    if (!selectedCompanyId) return;
    queryClient.setQueryData<Agent[]>(queryKeys.agents.list(selectedCompanyId), (current) =>
      current?.map((agent) => agent.id === result.agent.id ? result.agent : agent));
    queryClient.setQueryData<AgentAssignmentsOverview>(
      queryKeys.agentAssignments.list(selectedCompanyId),
      (current) => {
        const assignments = current?.assignments ?? [];
        const next = { agent: result.agent, assignmentVersion: result.assignmentVersion };
        return {
          assignments: assignments.some((entry) => entry.agent.id === result.agent.id)
            ? assignments.map((entry) => entry.agent.id === result.agent.id ? next : entry)
            : [...assignments, next],
        };
      },
    );
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(selectedCompanyId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.codexAccounts.list(selectedCompanyId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.claudeAccounts.list(selectedCompanyId) }),
    ]);
  };

  if (!selectedCompanyId || !selectedCompany) {
    return <div className="text-sm text-muted-foreground">Select a company to manage agent assignments.</div>;
  }

  return (
    <div className="max-w-5xl space-y-6">
      <div className="flex items-start gap-3">
        <div className="rounded-md border border-border bg-muted/40 p-2">
          <Link2 className="h-5 w-5 text-muted-foreground" />
        </div>
        <div>
          <h1 className="text-lg font-semibold">Agent assignments</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Choose one provider or configure both in priority order. Failover moves new attempts to the next provider when quota is unavailable.
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
        . Each run uses one provider; crossing providers starts a fresh session. The server host session uses the Paperclip machine's shared CLI login. On Railway, prefer a managed account because host login may not be durable across deploys.
      </div>

      <section className="space-y-3" aria-labelledby="agent-assignments-heading">
        <div className="flex items-center justify-between gap-3">
          <h2 id="agent-assignments-heading" className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Agents
          </h2>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void refreshAll()}
            disabled={assignmentsQuery.isFetching}
          >
            {assignmentsQuery.isFetching ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
            Refresh
          </Button>
        </div>

        {codexQuery.isError ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
            Codex accounts could not be loaded. Claude-only assignments remain available.
          </div>
        ) : null}
        {claudeQuery.isError ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
            Claude accounts could not be loaded. Codex-only assignments remain available.
          </div>
        ) : null}

        {assignmentsQuery.isPending ? (
          <div className="flex items-center gap-2 rounded-md border border-border p-4 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading agents…
          </div>
        ) : assignmentsQuery.isError ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
            {assignmentsQuery.error.message}
          </div>
        ) : assignmentSnapshots.length === 0 ? (
          <div className="rounded-md border border-dashed border-border p-5 text-sm text-muted-foreground">
            No active agents in this company.
          </div>
        ) : (
          <div className="divide-y divide-border rounded-md border border-border">
            {assignmentSnapshots.map(({ agent, assignmentVersion }) => {
              const agentCodexMeta = codexMeta.get(agent.id);
              const agentClaudeMeta = claudeMeta.get(agent.id);
              return (
                <AgentAssignmentRow
                  key={agent.id}
                  agent={agent}
                  companyId={selectedCompanyId}
                  assignmentVersion={assignmentVersion}
                  codexState={{
                    accounts: codexAccounts,
                    authenticatedIds: authenticatedCodexIds,
                    ready: codexQuery.isSuccess,
                    loading: codexQuery.isPending,
                    error: codexQuery.error?.message ?? null,
                    blocker: agentCodexMeta?.canUseSubscriptionAccount === false
                      ? agentCodexMeta.subscriptionAccountBlocker ?? "Codex subscription accounts are blocked for this agent."
                      : null,
                  }}
                  claudeState={{
                    accounts: claudeAccounts,
                    authenticatedIds: authenticatedClaudeIds,
                    ready: claudeQuery.isSuccess,
                    loading: claudeQuery.isPending,
                    error: claudeQuery.error?.message ?? null,
                    blocker: agentClaudeMeta?.canUseSubscriptionAccount === false
                      ? agentClaudeMeta.subscriptionAccountBlocker ?? "Claude subscription accounts are blocked for this agent."
                      : null,
                  }}
                  onSaved={applySavedResult}
                  onConflict={refreshAll}
                />
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
