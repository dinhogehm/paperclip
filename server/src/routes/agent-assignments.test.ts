import { describe, expect, it } from "vitest";
import { updateAgentAssignmentsSchema } from "./agent-assignments.js";

const accountId = "33333333-3333-4333-8333-333333333333";

function validBody() {
  return {
    strategy: "failover",
    preferredProvider: "codex_local",
    codex: { mode: "fixed", accountId },
    claude: { mode: "first_available", accountId: null },
    expectedAssignmentVersion: "55555555-5555-4555-8555-555555555555",
  };
}

describe("updateAgentAssignmentsSchema", () => {
  it("accepts the complete atomic assignment contract", () => {
    expect(updateAgentAssignmentsSchema.safeParse(validBody()).success).toBe(true);
  });

  it("requires the opaque assignment version, including explicit null for an unrevised agent", () => {
    const { expectedAssignmentVersion: _expectedAssignmentVersion, ...missing } = validBody();
    expect(updateAgentAssignmentsSchema.safeParse(missing).success).toBe(false);
    expect(updateAgentAssignmentsSchema.safeParse({
      ...validBody(),
      expectedAssignmentVersion: null,
    }).success).toBe(true);
  });

  it("does not accept the old updatedAt concurrency contract", () => {
    const { expectedAssignmentVersion: _expectedAssignmentVersion, ...body } = validBody();
    expect(updateAgentAssignmentsSchema.safeParse({
      ...body,
      expectedUpdatedAt: "2026-08-15T10:00:00.000Z",
    }).success).toBe(false);
  });

  it("requires an account id for fixed assignments", () => {
    const result = updateAgentAssignmentsSchema.safeParse({
      ...validBody(),
      codex: { mode: "fixed", accountId: null },
    });

    expect(result.success).toBe(false);
  });

  it("rejects an account id for host or automatic assignments", () => {
    const result = updateAgentAssignmentsSchema.safeParse({
      ...validBody(),
      claude: { mode: "first_available", accountId },
    });

    expect(result.success).toBe(false);
  });

  it("rejects partial requests so a provider assignment cannot be silently cleared", () => {
    const { claude: _claude, ...partial } = validBody();
    expect(updateAgentAssignmentsSchema.safeParse(partial).success).toBe(false);
  });
});
