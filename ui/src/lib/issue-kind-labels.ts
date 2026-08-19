import type { IssueLabel } from "@paperclipai/shared";

export const ISSUE_KIND_LABELS = {
  bug: { name: "bug", color: "#c2410c", title: "Bug" },
  hotfix: { name: "hotfix", color: "#b91c1c", title: "Hotfix" },
} as const;

export type IssueKindKey = keyof typeof ISSUE_KIND_LABELS;

export function findKindLabel(
  labels: readonly IssueLabel[] | undefined,
  kind: IssueKindKey,
): IssueLabel | null {
  const name = ISSUE_KIND_LABELS[kind].name;
  return (labels ?? []).find((label) => label.name.toLowerCase() === name) ?? null;
}

export function issueHasKind(
  issue: { labelIds?: string[] | null; labels?: IssueLabel[] | null },
  kind: IssueKindKey,
  catalog?: readonly IssueLabel[],
): boolean {
  const label = findKindLabel([...(catalog ?? []), ...(issue.labels ?? [])], kind);
  if (!label) return false;
  if ((issue.labelIds ?? []).includes(label.id)) return true;
  return (issue.labels ?? []).some((entry) => entry.id === label.id);
}

export function nextLabelIdsForKinds(input: {
  labelIds: string[];
  catalog: readonly IssueLabel[];
  bug: boolean;
  hotfix: boolean;
}): string[] {
  const bugLabel = findKindLabel(input.catalog, "bug");
  const hotfixLabel = findKindLabel(input.catalog, "hotfix");
  const reserved = new Set(
    [bugLabel?.id, hotfixLabel?.id].filter((id): id is string => Boolean(id)),
  );
  const kept = input.labelIds.filter((id) => !reserved.has(id));
  const next = [...kept];
  const wantBug = input.bug || input.hotfix;
  if (wantBug && bugLabel && !next.includes(bugLabel.id)) next.push(bugLabel.id);
  if (input.hotfix && hotfixLabel && !next.includes(hotfixLabel.id)) next.push(hotfixLabel.id);
  return next;
}
