import type {
  Agent,
  CodexAccountAssignment,
  CodexAccountLoginState,
  CodexAccountsOverview,
} from "@paperclipai/shared";
import { api } from "./client";

function basePath(companyId: string) {
  return `/companies/${encodeURIComponent(companyId)}/codex-accounts`;
}

export const codexAccountsApi = {
  list: (companyId: string) => api.get<CodexAccountsOverview>(basePath(companyId)),
  create: (companyId: string, name: string) =>
    api.post<CodexAccountsOverview["accounts"][number]>(basePath(companyId), { name }),
  startLogin: (companyId: string, accountId: string) =>
    api.post<CodexAccountLoginState>(
      `${basePath(companyId)}/${encodeURIComponent(accountId)}/login`,
      {},
    ),
  assignAgent: (companyId: string, agentId: string, assignment: CodexAccountAssignment) =>
    api.put<Agent>(
      `${basePath(companyId)}/agents/${encodeURIComponent(agentId)}`,
      assignment,
    ),
  remove: (companyId: string, accountId: string) =>
    api.delete<void>(`${basePath(companyId)}/${encodeURIComponent(accountId)}`),
};
