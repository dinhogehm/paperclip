import type { Agent } from "@paperclipai/shared";
import { api } from "./client";

export type SubscriptionProvider = "codex_local" | "claude_local";
export type AgentAssignmentStrategy = "single" | "failover";
export type SubscriptionAccountMode = "host" | "fixed" | "first_available";

export interface SubscriptionAccountAssignment {
  mode: SubscriptionAccountMode;
  accountId: string | null;
}

export interface UpdateAgentAssignmentInput {
  strategy: AgentAssignmentStrategy;
  preferredProvider: SubscriptionProvider;
  codex: SubscriptionAccountAssignment;
  claude: SubscriptionAccountAssignment;
  expectedAssignmentVersion: string | null;
}

export interface AgentAssignmentVersion {
  agent: Agent;
  assignmentVersion: string | null;
}

export interface AgentAssignmentsOverview {
  assignments: AgentAssignmentVersion[];
}

export interface UpdateAgentAssignmentResponse {
  agent: Agent;
  assignmentVersion: string | null;
}

function basePath(companyId: string) {
  return `/companies/${encodeURIComponent(companyId)}/agent-assignments`;
}

export const agentAssignmentsApi = {
  list: (companyId: string) => api.get<AgentAssignmentsOverview>(basePath(companyId)),
  update: (
    companyId: string,
    agentId: string,
    input: UpdateAgentAssignmentInput,
  ) => api.put<UpdateAgentAssignmentResponse>(
    `${basePath(companyId)}/${encodeURIComponent(agentId)}`,
    input,
  ),
};
