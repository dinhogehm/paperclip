import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  CircleAlert,
  Copy,
  ExternalLink,
  KeyRound,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import type {
  CodexAccount,
  CodexAccountQuotaWindow,
} from "@paperclipai/shared";
import { codexAccountsApi } from "@/api/codexAccounts";
import { Button } from "@/components/ui/button";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { copyTextToClipboard } from "@/lib/clipboard";
import { Link } from "@/lib/router";
import { queryKeys } from "@/lib/queryKeys";
import { formatDateTime } from "@/lib/utils";

function accountStatusLabel(account: CodexAccount) {
  if (account.authenticated) return "Authenticated";
  if (account.login.status === "waiting_for_user") return "Waiting for login";
  if (account.login.status === "expired") return "Login expired";
  if (account.login.status === "failed") return "Login failed";
  return "Not authenticated";
}

function accountIdentity(account: CodexAccount) {
  if (account.email && account.planType) return `${account.email} · ${account.planType}`;
  return account.email ?? account.planType ?? "ChatGPT subscription";
}

function clampPercent(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function formatResetCountdown(resetsAt: string, now = Date.now()) {
  const resetTime = new Date(resetsAt).getTime();
  if (!Number.isFinite(resetTime)) return null;
  const minutes = Math.max(0, Math.ceil((resetTime - now) / 60_000));
  if (minutes === 0) return "due now";
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24) return `in ${hours}h${remainingMinutes ? ` ${remainingMinutes}m` : ""}`;
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return `in ${days}d${remainingHours ? ` ${remainingHours}h` : ""}`;
}

function quotaStatusLabel(account: CodexAccount) {
  if (account.quota.status === "available") return "Available now";
  if (account.quota.status === "exhausted") return "Limit reached";
  if (account.quota.status === "unauthenticated") return "Sign in to view usage";
  return "Availability unknown";
}

function QuotaWindow({ window }: { window: CodexAccountQuotaWindow }) {
  const usedPercent = window.usedPercent == null ? null : clampPercent(window.usedPercent);
  const availablePercent = usedPercent == null ? null : 100 - usedPercent;
  const resetCountdown = window.resetsAt ? formatResetCountdown(window.resetsAt) : null;

  return (
    <div className="space-y-2 rounded-md border border-border bg-muted/30 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <span className="font-medium">{window.label}</span>
        <span className="font-mono text-muted-foreground">
          {availablePercent == null
            ? window.valueLabel ?? "Usage not reported"
            : `${availablePercent}% available`}
        </span>
      </div>
      {usedPercent == null ? null : (
        <>
          <div
            className="h-2 overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-label={`${window.label} usage`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={usedPercent}
          >
            <div
              className={`h-full rounded-full ${usedPercent >= 100 ? "bg-destructive" : "bg-primary"}`}
              style={{ width: `${usedPercent}%` }}
            />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <span className="font-mono">{usedPercent}% used</span>
            {window.resetsAt ? (
              <time dateTime={window.resetsAt} title={formatDateTime(window.resetsAt)}>
                Resets {formatDateTime(window.resetsAt)}{resetCountdown ? ` · ${resetCountdown}` : ""}
              </time>
            ) : (
              <span>Reset time not reported</span>
            )}
          </div>
        </>
      )}
      {window.detail ? <p className="text-xs text-muted-foreground">{window.detail}</p> : null}
    </div>
  );
}

export function CompanyCodexAccounts() {
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [accountName, setAccountName] = useState("");
  const [copiedAccountId, setCopiedAccountId] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? "Company", href: "/dashboard" },
      { label: "Settings", href: "/company/settings" },
      { label: "Codex accounts" },
    ]);
  }, [selectedCompany?.name, setBreadcrumbs]);

  const accountsQuery = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.codexAccounts.list(selectedCompanyId)
      : ["codex-accounts", "__disabled__"],
    queryFn: () => codexAccountsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
    refetchInterval: (query) =>
      query.state.data?.accounts.some((account) => account.login.status === "waiting_for_user")
        ? 2_000
        : 60_000,
  });

  const invalidateAccounts = async () => {
    if (!selectedCompanyId) return;
    await queryClient.invalidateQueries({
      queryKey: queryKeys.codexAccounts.list(selectedCompanyId),
    });
    await queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(selectedCompanyId) });
  };

  const createMutation = useMutation({
    mutationFn: (name: string) => codexAccountsApi.create(selectedCompanyId!, name),
    onSuccess: async (account) => {
      setAccountName("");
      await invalidateAccounts();
      loginMutation.mutate(account.id);
    },
  });

  const loginMutation = useMutation({
    mutationFn: (accountId: string) => codexAccountsApi.startLogin(selectedCompanyId!, accountId),
    onSuccess: invalidateAccounts,
  });

  const removeMutation = useMutation({
    mutationFn: (accountId: string) => codexAccountsApi.remove(selectedCompanyId!, accountId),
    onSuccess: invalidateAccounts,
  });

  const authenticatedAccounts = useMemo(
    () => accountsQuery.data?.accounts.filter((account) => account.authenticated) ?? [],
    [accountsQuery.data?.accounts],
  );

  if (!selectedCompanyId || !selectedCompany) {
    return <div className="text-sm text-muted-foreground">Select a company to manage Codex accounts.</div>;
  }

  return (
    <div className="max-w-3xl space-y-6">
      <div className="flex items-start gap-3">
        <div className="rounded-md border border-border bg-muted/40 p-2">
          <KeyRound className="h-5 w-5 text-muted-foreground" />
        </div>
        <div>
          <h1 className="text-lg font-semibold">Codex accounts</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Authenticate multiple ChatGPT accounts and choose which Codex agents use each account.
          </p>
        </div>
      </div>

      <div className="rounded-md border border-border bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
        Paperclip stores only account labels and agent assignments in the database. Codex keeps the
        authentication session in an isolated local profile for each account.
      </div>

      <section className="space-y-3" aria-labelledby="add-codex-account-heading">
        <div>
          <h2 id="add-codex-account-heading" className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Add account
          </h2>
        </div>
        <form
          className="flex flex-col gap-2 rounded-md border border-border p-4 sm:flex-row"
          onSubmit={(event) => {
            event.preventDefault();
            const name = accountName.trim();
            if (name) createMutation.mutate(name);
          }}
        >
          <input
            aria-label="Account label"
            className="min-w-0 flex-1 rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
            value={accountName}
            onChange={(event) => setAccountName(event.target.value)}
            placeholder="Example: Pro account 2"
            maxLength={80}
          />
          <Button type="submit" size="sm" disabled={!accountName.trim() || createMutation.isPending}>
            {createMutation.isPending ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Plus className="mr-1.5 h-3.5 w-3.5" />
            )}
            Add and authenticate
          </Button>
        </form>
        {createMutation.isError ? (
          <p className="text-xs text-destructive">{createMutation.error.message}</p>
        ) : null}
      </section>

      <section className="space-y-3" aria-labelledby="authenticated-accounts-heading">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 id="authenticated-accounts-heading" className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Accounts
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Shows every rolling window currently reported by OpenAI. Usage refreshes every minute.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">
              {authenticatedAccounts.length} authenticated
            </span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void accountsQuery.refetch()}
              disabled={accountsQuery.isFetching}
            >
              <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${accountsQuery.isFetching ? "animate-spin" : ""}`} />
              Refresh usage
            </Button>
          </div>
        </div>

        {accountsQuery.isPending ? (
          <div className="flex items-center gap-2 rounded-md border border-border p-4 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading accounts…
          </div>
        ) : accountsQuery.isError ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
            {accountsQuery.error.message}
          </div>
        ) : accountsQuery.data.accounts.length === 0 ? (
          <div className="rounded-md border border-dashed border-border p-5 text-sm text-muted-foreground">
            No dedicated account yet. Add the first account above.
          </div>
        ) : (
          <div className="space-y-3">
            {accountsQuery.data.accounts.map((account) => {
              const waiting = account.login.status === "waiting_for_user";
              const failed = account.login.status === "failed" || account.login.status === "expired";
              return (
                <article key={account.id} className="rounded-md border border-border p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        {account.authenticated ? (
                          <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                        ) : failed ? (
                          <CircleAlert className="h-4 w-4 text-destructive" />
                        ) : waiting ? (
                          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                        ) : (
                          <KeyRound className="h-4 w-4 text-muted-foreground" />
                        )}
                        <h3 className="truncate text-sm font-medium">{account.name}</h3>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {accountStatusLabel(account)}
                        {account.authenticated ? ` · ${accountIdentity(account)}` : ""}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {account.assignedAgentIds.length} assigned agent{account.assignedAgentIds.length === 1 ? "" : "s"}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => loginMutation.mutate(account.id)}
                        disabled={loginMutation.isPending}
                      >
                        {account.authenticated ? "Reauthenticate" : "Authenticate"}
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label={`Remove ${account.name}`}
                        title={account.assignedAgentIds.length > 0 ? "Unassign all agents first" : "Remove account"}
                        disabled={account.assignedAgentIds.length > 0 || removeMutation.isPending}
                        onClick={() => {
                          if (window.confirm(`Remove Codex account "${account.name}" and its local login?`)) {
                            removeMutation.mutate(account.id);
                          }
                        }}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>

                  {account.authenticated ? (
                    <div className="mt-4 space-y-3 border-t border-border pt-3" aria-label={`Usage limits for ${account.name}`}>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className={`text-xs font-medium ${account.quota.status === "exhausted" ? "text-destructive" : "text-foreground"}`}>
                          {quotaStatusLabel(account)}
                        </p>
                        {account.quota.fetchedAt ? (
                          <time
                            className="font-mono text-xs text-muted-foreground"
                            dateTime={account.quota.fetchedAt}
                            title={formatDateTime(account.quota.fetchedAt)}
                          >
                            Updated {formatDateTime(account.quota.fetchedAt)}
                          </time>
                        ) : null}
                      </div>
                      {account.quota.windows.length > 0 ? (
                        <div className="grid gap-2 sm:grid-cols-2">
                          {account.quota.windows.map((window) => (
                            <QuotaWindow key={`${window.label}-${window.resetsAt ?? "no-reset"}`} window={window} />
                          ))}
                        </div>
                      ) : account.quota.error ? (
                        <p className="text-xs text-muted-foreground">{account.quota.error}</p>
                      ) : null}
                    </div>
                  ) : null}

                  {waiting && account.login.userCode && account.login.verificationUrl ? (
                    <div className="mt-4 rounded-md border border-border bg-muted/40 p-3">
                      <p className="text-xs text-muted-foreground">
                        Open the official login page, sign in to this account, then enter the one-time code:
                      </p>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <code className="rounded-md border border-border bg-background px-3 py-1.5 text-sm font-semibold tracking-wider">
                          {account.login.userCode}
                        </code>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={async () => {
                            await copyTextToClipboard(account.login.userCode!);
                            setCopiedAccountId(account.id);
                          }}
                        >
                          <Copy className="mr-1.5 h-3.5 w-3.5" />
                          {copiedAccountId === account.id ? "Copied" : "Copy code"}
                        </Button>
                        <Button size="sm" asChild>
                          <a href={account.login.verificationUrl} target="_blank" rel="noreferrer">
                            Open login
                            <ExternalLink className="ml-1.5 h-3.5 w-3.5" />
                          </a>
                        </Button>
                      </div>
                    </div>
                  ) : null}
                  {account.login.error ? (
                    <p className="mt-3 text-xs text-destructive">{account.login.error}</p>
                  ) : null}
                </article>
              );
            })}
          </div>
        )}
        {loginMutation.isError ? (
          <p className="text-xs text-destructive">{loginMutation.error.message}</p>
        ) : null}
        {removeMutation.isError ? (
          <p className="text-xs text-destructive">{removeMutation.error.message}</p>
        ) : null}
      </section>

      <section className="space-y-3 rounded-md border border-border p-4" aria-labelledby="agent-assignments-heading">
        <h2 id="agent-assignments-heading" className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Agent assignments
        </h2>
        <p className="text-sm text-muted-foreground">
          Assign Codex or Claude accounts to any agent from the shared assignments page.
        </p>
        <Button size="sm" variant="outline" asChild>
          <Link to="/company/settings/agent-assignments">Open agent assignments</Link>
        </Button>
      </section>
    </div>
  );
}
