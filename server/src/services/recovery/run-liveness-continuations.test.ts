import { describe, expect, it } from "vitest";
import { FINISH_SUCCESSFUL_RUN_HANDOFF_REASON } from "./successful-run-handoff.js";
import { decideRunLivenessContinuation } from "./run-liveness-continuations.js";

const companyId = "company-1";
const agentId = "agent-1";
const issueId = "issue-1";

function decideForCorrectiveHandoff() {
  return decideRunLivenessContinuation({
    run: {
      id: "run-1",
      companyId,
      agentId,
      status: "succeeded",
      continuationAttempt: 0,
      contextSnapshot: { wakeReason: FINISH_SUCCESSFUL_RUN_HANDOFF_REASON },
    } as any,
    issue: {
      id: issueId,
      companyId,
      identifier: "PAP-1",
      title: "Completed delivery",
      status: "in_progress",
      assigneeAgentId: agentId,
      executionState: null,
      projectId: null,
    } as any,
    agent: {
      id: agentId,
      companyId,
      status: "idle",
    } as any,
    livenessState: "plan_only",
    livenessReason: "Run described future work",
    nextAction: null,
    budgetBlocked: false,
    idempotentWakeExists: false,
  });
}

describe("decideRunLivenessContinuation", () => {
  it("does not reschedule a corrective disposition handoff", () => {
    expect(decideForCorrectiveHandoff()).toEqual({
      kind: "skip",
      reason: "corrective handoff run owns issue disposition recovery",
    });
  });
});
