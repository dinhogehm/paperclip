import { ISSUE_STATUSES, type IssueStatus } from "@paperclipai/shared";

export const ISSUE_STATUS_LABELS: Record<IssueStatus, string> = {
  backlog: "Backlog",
  todo: "Todo",
  in_progress: "In progress",
  in_review: "In review",
  pr_open: "PR aberta",
  merged: "Mesclado",
  in_production: "Publicado em produção",
  blocked: "Blocked",
  done: "Done",
  cancelled: "Cancelled",
};

export const ISSUE_STATUS_PICKER_ORDER: IssueStatus[] = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "pr_open",
  "merged",
  "in_production",
  "blocked",
  "done",
  "cancelled",
];

export function issueStatusLabel(status: string): string {
  if ((ISSUE_STATUSES as readonly string[]).includes(status)) {
    return ISSUE_STATUS_LABELS[status as IssueStatus];
  }
  return status.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}
