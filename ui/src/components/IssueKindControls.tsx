import { Bug, Flame } from "lucide-react";
import type { IssueLabel } from "@paperclipai/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import {
  ISSUE_KIND_LABELS,
  findKindLabel,
  issueHasKind,
  nextLabelIdsForKinds,
  type IssueKindKey,
} from "../lib/issue-kind-labels";
import { cn } from "../lib/utils";

interface IssueKindState {
  companyId: string | null | undefined;
  labelIds: string[];
  labels: IssueLabel[] | undefined;
  issueLabels?: IssueLabel[] | null;
  onChange: (patch: { labelIds: string[]; priority?: string }) => void;
}

export function useIssueKindActions({
  companyId,
  labelIds,
  labels,
  issueLabels,
  onChange,
}: IssueKindState) {
  const queryClient = useQueryClient();
  const isBug = issueHasKind({ labelIds, labels: issueLabels }, "bug", labels);
  const isHotfix = issueHasKind({ labelIds, labels: issueLabels }, "hotfix", labels);

  const ensureLabels = useMutation({
    mutationFn: async (needed: IssueKindKey[]) => {
      if (!companyId) return labels ?? [];
      let catalog = [...(labels ?? [])];
      for (const kind of needed) {
        if (findKindLabel(catalog, kind)) continue;
        const spec = ISSUE_KIND_LABELS[kind];
        const created = await issuesApi.createLabel(companyId, {
          name: spec.name,
          color: spec.color,
        });
        catalog = [...catalog, created];
      }
      return catalog;
    },
    onSuccess: (catalog) => {
      if (!companyId) return;
      queryClient.setQueryData<IssueLabel[] | undefined>(
        queryKeys.issues.labels(companyId),
        catalog,
      );
    },
  });

  async function apply(next: { bug: boolean; hotfix: boolean }) {
    const needed: IssueKindKey[] = [];
    if (next.bug || next.hotfix) needed.push("bug");
    if (next.hotfix) needed.push("hotfix");
    const catalog = needed.length > 0
      ? await ensureLabels.mutateAsync(needed)
      : (labels ?? []);
    onChange({
      labelIds: nextLabelIdsForKinds({
        labelIds,
        catalog,
        bug: next.bug,
        hotfix: next.hotfix,
      }),
      ...(next.hotfix ? { priority: "critical" } : {}),
    });
  }

  return {
    isBug,
    isHotfix,
    pending: ensureLabels.isPending,
    apply,
  };
}

export function IssueKindTypeButtons({
  isBug,
  isHotfix,
  onApply,
}: {
  isBug: boolean;
  isHotfix: boolean;
  onApply: (next: { bug: boolean; hotfix: boolean }) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Button
        type="button"
        size="sm"
        variant={!isBug && !isHotfix ? "secondary" : "outline"}
        className="h-7"
        data-testid="issue-kind-trabalho"
        onClick={() => onApply({ bug: false, hotfix: false })}
      >
        Trabalho
      </Button>
      <Button
        type="button"
        size="sm"
        variant={isBug || isHotfix ? "secondary" : "outline"}
        className="h-7 gap-1.5"
        data-testid="issue-kind-bug"
        onClick={() => onApply({ bug: true, hotfix: isHotfix })}
      >
        <Bug className="h-3.5 w-3.5" />
        Bug
      </Button>
    </div>
  );
}

export function IssueKindHotfixToggle({
  isBug,
  isHotfix,
  disabled,
  onApply,
}: {
  isBug: boolean;
  isHotfix: boolean;
  disabled?: boolean;
  onApply: (next: { bug: boolean; hotfix: boolean }) => void;
}) {
  return (
    <label className="flex min-w-0 items-center gap-2 text-sm">
      <ToggleSwitch
        checked={isHotfix}
        disabled={disabled}
        onCheckedChange={(checked) => {
          onApply({ bug: checked ? true : isBug, hotfix: checked });
        }}
        aria-label="Marcar como hotfix de produção"
      />
      <span className={cn("inline-flex min-w-0 items-center gap-1.5", isHotfix && "text-red-600 dark:text-red-400")}>
        <Flame className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">Produção quebrada agora</span>
      </span>
    </label>
  );
}

export function IssueKindControls(props: IssueKindState) {
  const kind = useIssueKindActions(props);
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <IssueKindTypeButtons isBug={kind.isBug} isHotfix={kind.isHotfix} onApply={(next) => void kind.apply(next)} />
      <IssueKindHotfixToggle
        isBug={kind.isBug}
        isHotfix={kind.isHotfix}
        disabled={!props.companyId || kind.pending}
        onApply={(next) => void kind.apply(next)}
      />
    </div>
  );
}
