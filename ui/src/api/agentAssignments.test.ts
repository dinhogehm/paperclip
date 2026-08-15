import { beforeEach, describe, expect, it, vi } from "vitest";

const mockApi = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn() }));

vi.mock("./client", () => ({ api: mockApi }));

import { agentAssignmentsApi, type UpdateAgentAssignmentInput } from "./agentAssignments";

describe("agentAssignmentsApi", () => {
  beforeEach(() => {
    mockApi.get.mockReset();
    mockApi.put.mockReset();
  });

  it("loads opaque assignment versions from the company endpoint", async () => {
    mockApi.get.mockResolvedValue({ assignments: [] });

    await agentAssignmentsApi.list("company/1");

    expect(mockApi.get).toHaveBeenCalledWith("/companies/company%2F1/agent-assignments");
  });

  it("uses the company-scoped atomic endpoint with the required version", async () => {
    const input: UpdateAgentAssignmentInput = {
      strategy: "failover",
      preferredProvider: "claude_local",
      codex: { mode: "fixed", accountId: "codex-1" },
      claude: { mode: "first_available", accountId: null },
      expectedAssignmentVersion: "revision-1",
    };
    mockApi.put.mockResolvedValue({ agent: { id: "agent/1" }, assignmentVersion: "revision-2" });

    await agentAssignmentsApi.update("company/1", "agent/1", input);

    expect(mockApi.put).toHaveBeenCalledWith(
      "/companies/company%2F1/agent-assignments/agent%2F1",
      input,
    );
  });
});
