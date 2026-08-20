import { describe, expect, it } from "vitest";
import {
  NURIA_OPS_COMPANY_ID,
  isNuriaOpsCompany,
  resolveBoardIssuePriority,
  shouldEnforceBoardPriorityPolicy,
} from "./issue-priority-policy.js";

describe("shouldEnforceBoardPriorityPolicy", () => {
  it("applies only to the nuria-ops company", () => {
    expect(isNuriaOpsCompany(NURIA_OPS_COMPANY_ID)).toBe(true);
    expect(shouldEnforceBoardPriorityPolicy(NURIA_OPS_COMPANY_ID)).toBe(true);
    expect(shouldEnforceBoardPriorityPolicy("00000000-0000-0000-0000-000000000000")).toBe(false);
  });
});

describe("resolveBoardIssuePriority", () => {
  it("marks [HOTFIX] title as P0 even without the hotfix label", () => {
    expect(resolveBoardIssuePriority({
      title: "[HOTFIX] Inbox fora do ar",
      labelNames: ["bug"],
    })).toBe("critical");
  });

  it("marks the hotfix label as P0 even without the title tag", () => {
    expect(resolveBoardIssuePriority({
      title: "Auth 500 em produção",
      labelNames: ["Hotfix"],
    })).toBe("critical");
  });

  it("does not treat a bare critical request as hotfix", () => {
    expect(resolveBoardIssuePriority({
      title: "Qualquer card",
      labelNames: [],
    })).toBe("low");
  });

  it("marks the [Helpdesk] tag as P1", () => {
    expect(resolveBoardIssuePriority({
      title: "[Helpdesk] Fila não atualiza",
      labelNames: [],
    })).toBe("high");
  });

  it("does not treat [BI/Helpdesk] as the Helpdesk tag", () => {
    expect(resolveBoardIssuePriority({
      title: "[BI/Helpdesk] Dashboard",
      labelNames: [],
    })).toBe("low");
  });

  it("keeps hotfix above Helpdesk", () => {
    expect(resolveBoardIssuePriority({
      title: "[HOTFIX] [Helpdesk] WhatsApp caiu",
      labelNames: [],
    })).toBe("critical");
  });

  it("ignores an agent trying to force critical on a normal card", () => {
    expect(resolveBoardIssuePriority({
      title: "Refatorar listagem",
      labelNames: ["bug"],
      requestedPriority: "critical",
    })).toBe("low");
  });
});
