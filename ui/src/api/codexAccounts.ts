import type {
  Agent,
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
  assignAgent: (companyId: string, agentId: string, accountId: string | null) =>
    api.put<Agent>(
      `${basePath(companyId)}/agents/${encodeURIComponent(agentId)}`,
      { accountId },
    ),
  remove: (companyId: string, accountId: string) =>
    api.delete<void>(`${basePath(companyId)}/${encodeURIComponent(accountId)}`),
};
