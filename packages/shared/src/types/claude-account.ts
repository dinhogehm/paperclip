import type { AgentStatus } from "../constants.js";

export type ClaudeAccountMode = "host" | "fixed" | "first_available";

export interface ClaudeAccountAssignment {
  mode: ClaudeAccountMode;
  accountId: string | null;
}

export type ClaudeAccountLoginStatus =
  | "idle"
  | "waiting_for_user"
  | "authenticated"
  | "failed"
  | "expired";

export interface ClaudeAccountLoginState {
  status: ClaudeAccountLoginStatus;
  verificationUrl: string | null;
  startedAt: string | null;
  expiresAt: string | null;
  error: string | null;
}

export interface ClaudeAccountAgent {
  id: string;
  name: string;
  status: AgentStatus;
  claudeAccountMode: ClaudeAccountMode;
  claudeAccountId: string | null;
  canUseSubscriptionAccount: boolean;
  subscriptionAccountBlocker: string | null;
}

export type ClaudeAccountQuotaStatus = "available" | "exhausted" | "unknown" | "unauthenticated";

export interface ClaudeAccountQuotaWindow {
  label: string;
  usedPercent: number | null;
  resetsAt: string | null;
  valueLabel: string | null;
  detail: string | null;
}

export interface ClaudeAccountQuota {
  status: ClaudeAccountQuotaStatus;
  windows: ClaudeAccountQuotaWindow[];
  fetchedAt: string | null;
  error: string | null;
}

export interface ClaudeAccount {
  id: string;
  companyId: string;
  name: string;
  authenticated: boolean;
  authMethod: string | null;
  planType: string | null;
  lastAuthenticatedAt: string | null;
  assignedAgentIds: string[];
  quota: ClaudeAccountQuota;
  login: ClaudeAccountLoginState;
  createdAt: string;
  updatedAt: string;
}

export interface ClaudeAccountsOverview {
  accounts: ClaudeAccount[];
  agents: ClaudeAccountAgent[];
}
