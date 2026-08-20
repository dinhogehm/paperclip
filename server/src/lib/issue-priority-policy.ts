export const NURIA_OPS_COMPANY_ID = "a8d1813a-64d1-49e9-9026-b759128e448e";

export type BoardIssuePriority = "critical" | "high" | "medium" | "low";

const HELPDESK_TAG_RE = /\[helpdesk\]/i;
const HOTFIX_TAG_RE = /\[hotfix\]/i;

export function isNuriaOpsCompany(companyId: string | null | undefined): boolean {
  return companyId === NURIA_OPS_COMPANY_ID;
}

export function shouldEnforceBoardPriorityPolicy(companyId: string | null | undefined): boolean {
  return isNuriaOpsCompany(companyId);
}

function hasHotfixLabel(labelNames: readonly string[] | null | undefined): boolean {
  return (labelNames ?? []).some((name) => name.trim().toLowerCase() === "hotfix");
}

export function resolveBoardIssuePriority(input: {
  title?: string | null;
  labelNames?: readonly string[] | null;
  requestedPriority?: string | null;
}): BoardIssuePriority {
  const title = input.title ?? "";
  if (HOTFIX_TAG_RE.test(title) || hasHotfixLabel(input.labelNames)) {
    return "critical";
  }
  if (HELPDESK_TAG_RE.test(title)) {
    return "high";
  }
  return "low";
}
