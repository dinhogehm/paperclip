import type {
  Agent,
  ClaudeAccountAssignment,
  ClaudeAccountLoginState,
  ClaudeAccountsOverview,
} from "@paperclipai/shared";
import { api } from "./client";

function basePath(companyId: string) {
  return `/companies/${encodeURIComponent(companyId)}/claude-accounts`;
}

export const claudeAccountsApi = {
  list: (companyId: string) => api.get<ClaudeAccountsOverview>(basePath(companyId)),
  create: (companyId: string, name: string) =>
    api.post<ClaudeAccountsOverview["accounts"][number]>(basePath(companyId), { name }),
  startLogin: (companyId: string, accountId: string) =>
    api.post<ClaudeAccountLoginState>(`${basePath(companyId)}/${encodeURIComponent(accountId)}/login`, {}),
  assignAgent: (companyId: string, agentId: string, assignment: ClaudeAccountAssignment) =>
    api.put<Agent>(`${basePath(companyId)}/agents/${encodeURIComponent(agentId)}`, assignment),
  remove: (companyId: string, accountId: string) =>
    api.delete<void>(`${basePath(companyId)}/${encodeURIComponent(accountId)}`),
};
