import type { AgentStatus } from "../constants.js";

export type CodexAccountMode = "host" | "fixed" | "first_available";

export interface CodexAccountAssignment {
  mode: CodexAccountMode;
  accountId: string | null;
}

export type CodexAccountLoginStatus =
  | "idle"
  | "waiting_for_user"
  | "authenticated"
  | "failed"
  | "expired";

export interface CodexAccountLoginState {
  status: CodexAccountLoginStatus;
  verificationUrl: string | null;
  userCode: string | null;
  startedAt: string | null;
  expiresAt: string | null;
  error: string | null;
}

export interface CodexAccountAgent {
  id: string;
  name: string;
  status: AgentStatus;
  codexAccountMode: CodexAccountMode;
  codexAccountId: string | null;
  canUseSubscriptionAccount: boolean;
  subscriptionAccountBlocker: string | null;
}

export type CodexAccountQuotaStatus =
  | "available"
  | "exhausted"
  | "unknown"
  | "unauthenticated";

export interface CodexAccountQuotaWindow {
  label: string;
  usedPercent: number | null;
  resetsAt: string | null;
  valueLabel: string | null;
  detail: string | null;
}

export interface CodexAccountQuota {
  status: CodexAccountQuotaStatus;
  windows: CodexAccountQuotaWindow[];
  fetchedAt: string | null;
  error: string | null;
}

export interface CodexAccount {
  id: string;
  companyId: string;
  name: string;
  authenticated: boolean;
  email: string | null;
  planType: string | null;
  lastRefresh: string | null;
  lastAuthenticatedAt: string | null;
  assignedAgentIds: string[];
  quota: CodexAccountQuota;
  login: CodexAccountLoginState;
  createdAt: string;
  updatedAt: string;
}

export interface CodexAccountsOverview {
  accounts: CodexAccount[];
  agents: CodexAccountAgent[];
}
