import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, CircleAlert, ExternalLink, KeyRound, Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";
import { claudeAccountsApi } from "@/api/claudeAccounts";
import { Button } from "@/components/ui/button";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { Link } from "@/lib/router";
import { queryKeys } from "@/lib/queryKeys";
import { formatDateTime } from "@/lib/utils";

export function CompanyClaudeAccounts() {
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [accountName, setAccountName] = useState("");

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? "Company", href: "/dashboard" },
      { label: "Settings", href: "/company/settings" },
      { label: "Claude accounts" },
    ]);
  }, [selectedCompany?.name, setBreadcrumbs]);

  const accountsQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.claudeAccounts.list(selectedCompanyId) : ["claude-accounts", "__disabled__"],
    queryFn: () => claudeAccountsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
    refetchInterval: (query) => query.state.data?.accounts.some((account) =>
      account.login.status === "waiting_for_user") ? 2_000 : 60_000,
  });
  const invalidate = async () => {
    if (!selectedCompanyId) return;
    await queryClient.invalidateQueries({ queryKey: queryKeys.claudeAccounts.list(selectedCompanyId) });
    await queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(selectedCompanyId) });
  };
  const loginMutation = useMutation({
    mutationFn: (accountId: string) => claudeAccountsApi.startLogin(selectedCompanyId!, accountId),
    onSuccess: async (login) => {
      if (login.verificationUrl) window.open(login.verificationUrl, "_blank", "noopener,noreferrer");
      await invalidate();
    },
  });
  const createMutation = useMutation({
    mutationFn: (name: string) => claudeAccountsApi.create(selectedCompanyId!, name),
    onSuccess: async (account) => {
      setAccountName("");
      await invalidate();
      loginMutation.mutate(account.id);
    },
  });
  const removeMutation = useMutation({
    mutationFn: (accountId: string) => claudeAccountsApi.remove(selectedCompanyId!, accountId),
    onSuccess: invalidate,
  });

  if (!selectedCompanyId || !selectedCompany) {
    return <div className="text-sm text-muted-foreground">Select a company to manage Claude accounts.</div>;
  }

  return (
    <div className="max-w-3xl space-y-6">
      <div className="flex items-start gap-3">
        <div className="rounded-md border border-border bg-muted/40 p-2"><KeyRound className="h-5 w-5 text-muted-foreground" /></div>
        <div>
          <h1 className="text-lg font-semibold">Claude accounts</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Authenticate multiple Claude Pro or Max accounts and choose which Claude agents use each account.
          </p>
        </div>
      </div>
      <div className="rounded-md border border-border bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
        Paperclip stores only labels and assignments in the database. Claude keeps each login in an isolated local profile.
      </div>

      <section className="space-y-3" aria-labelledby="add-claude-account-heading">
        <h2 id="add-claude-account-heading" className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Add account</h2>
        <form className="flex flex-col gap-2 rounded-md border border-border p-4 sm:flex-row" onSubmit={(event) => {
          event.preventDefault();
          if (accountName.trim()) createMutation.mutate(accountName.trim());
        }}>
          <input
            aria-label="Account label"
            className="min-w-0 flex-1 rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
            value={accountName}
            onChange={(event) => setAccountName(event.target.value)}
            placeholder="Example: Claude Max 2"
            maxLength={80}
          />
          <Button type="submit" size="sm" disabled={!accountName.trim() || createMutation.isPending}>
            {createMutation.isPending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Plus className="mr-1.5 h-3.5 w-3.5" />}
            Add and authenticate
          </Button>
        </form>
      </section>

      <section className="space-y-3" aria-labelledby="claude-accounts-heading">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 id="claude-accounts-heading" className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Accounts</h2>
            <p className="mt-1 text-xs text-muted-foreground">Usage windows refresh every minute.</p>
          </div>
          <Button size="sm" variant="ghost" onClick={() => void accountsQuery.refetch()} disabled={accountsQuery.isFetching}>
            <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${accountsQuery.isFetching ? "animate-spin" : ""}`} />Refresh usage
          </Button>
        </div>
        {accountsQuery.isPending ? (
          <div className="flex items-center gap-2 rounded-md border border-border p-4 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading accounts…</div>
        ) : accountsQuery.isError ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">{accountsQuery.error.message}</div>
        ) : accountsQuery.data.accounts.length === 0 ? (
          <div className="rounded-md border border-dashed border-border p-5 text-sm text-muted-foreground">No dedicated account yet.</div>
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
                        {account.authenticated ? <CheckCircle2 className="h-4 w-4 text-emerald-500" /> : failed ? <CircleAlert className="h-4 w-4 text-destructive" /> : waiting ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4 text-muted-foreground" />}
                        <h3 className="truncate text-sm font-medium">{account.name}</h3>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {account.authenticated ? `Authenticated · ${account.planType ?? "Claude subscription"}` : waiting ? "Waiting for browser login" : "Not authenticated"}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">{account.assignedAgentIds.length} assigned agents</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button size="sm" variant="outline" onClick={() => loginMutation.mutate(account.id)} disabled={loginMutation.isPending}>
                        {account.authenticated ? "Reauthenticate" : "Authenticate"}
                      </Button>
                      <Button size="icon" variant="ghost" aria-label={`Remove ${account.name}`} disabled={account.assignedAgentIds.length > 0 || removeMutation.isPending} onClick={() => {
                        if (window.confirm(`Remove Claude account "${account.name}" and its local login?`)) removeMutation.mutate(account.id);
                      }}><Trash2 className="h-4 w-4" /></Button>
                    </div>
                  </div>
                  {waiting ? (
                    <div className="mt-3 rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
                      Complete the Claude login in the browser window opened by the CLI.
                      {account.login.verificationUrl ? <Button size="sm" variant="link" asChild><a href={account.login.verificationUrl} target="_blank" rel="noreferrer">Open login<ExternalLink className="ml-1 h-3.5 w-3.5" /></a></Button> : null}
                    </div>
                  ) : null}
                  {account.login.error ? <p className="mt-3 text-xs text-destructive">{account.login.error}</p> : null}
                  {account.authenticated ? (
                    <div className="mt-4 grid gap-2 border-t border-border pt-3 sm:grid-cols-2 lg:grid-cols-3">
                      {account.quota.windows.length ? account.quota.windows.map((window) => {
                        const used = window.usedPercent == null ? null : Math.max(0, Math.min(100, Math.round(window.usedPercent)));
                        return <div key={`${window.label}-${window.resetsAt ?? "none"}`} className="space-y-2 rounded-md border border-border bg-muted/30 p-3">
                          <div className="flex justify-between gap-2 text-xs"><span className="font-medium">{window.label}</span><span className="font-mono text-muted-foreground">{used == null ? window.valueLabel ?? "Unknown" : `${100 - used}% available`}</span></div>
                          {used == null ? null : <div className="h-2 overflow-hidden rounded-full bg-muted"><div className={`h-full rounded-full ${used >= 100 ? "bg-destructive" : "bg-primary"}`} style={{ width: `${used}%` }} /></div>}
                          <p className="text-xs text-muted-foreground">{window.resetsAt ? `Resets ${formatDateTime(window.resetsAt)}` : window.detail ?? "Reset time not reported"}</p>
                        </div>;
                      }) : <p className="text-xs text-muted-foreground">{account.quota.error ?? "Usage not reported."}</p>}
                    </div>
                  ) : null}
                </article>
              );
            })}
          </div>
        )}
        {[createMutation, loginMutation, removeMutation].map((mutation, index) => mutation.isError
          ? <p key={index} className="text-xs text-destructive">{mutation.error.message}</p>
          : null)}
      </section>

      <section className="space-y-3 rounded-md border border-border p-4" aria-labelledby="claude-agent-assignments-heading">
        <h2 id="claude-agent-assignments-heading" className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Agent assignments</h2>
        <p className="text-sm text-muted-foreground">
          Assign Claude or Codex accounts to any agent from the shared assignments page.
        </p>
        <Button size="sm" variant="outline" asChild>
          <Link to="/company/settings/agent-assignments">Open agent assignments</Link>
        </Button>
      </section>
    </div>
  );
}
