export const ISSUE_PRIORITY_VALUES = ["critical", "high", "medium", "low"] as const;
export type IssuePriorityValue = (typeof ISSUE_PRIORITY_VALUES)[number];

/** Visible scale. API values stay critical/high/medium/low. */
export const ISSUE_PRIORITY_LABELS: Record<IssuePriorityValue, string> = {
  critical: "P0",
  high: "P1",
  medium: "P2",
  low: "P3",
};

export const ISSUE_PRIORITY_DESCRIPTIONS: Record<IssuePriorityValue, string> = {
  critical: "Produção quebrada agora",
  high: "Grave, há workaround",
  medium: "Planejado / não bloqueia",
  low: "Melhoria / débito",
};

export function issuePriorityLabel(priority: string): string {
  if (priority in ISSUE_PRIORITY_LABELS) {
    return ISSUE_PRIORITY_LABELS[priority as IssuePriorityValue];
  }
  return ISSUE_PRIORITY_LABELS.medium;
}

export function isIssuePriorityValue(value: string): value is IssuePriorityValue {
  return ISSUE_PRIORITY_VALUES.includes(value as IssuePriorityValue);
}
