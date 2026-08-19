import { Bug, Flame } from "lucide-react";
import type { IssueLabel } from "@paperclipai/shared";
import { Badge } from "@/components/ui/badge";
import { issueHasKind } from "../lib/issue-kind-labels";
import { cn } from "../lib/utils";

export function IssueKindBadges({
  issue,
  catalog,
  className,
}: {
  issue: { labelIds?: string[] | null; labels?: IssueLabel[] | null };
  catalog?: IssueLabel[];
  className?: string;
}) {
  const isHotfix = issueHasKind(issue, "hotfix", catalog);
  const isBug = issueHasKind(issue, "bug", catalog);
  if (!isHotfix && !isBug) return null;

  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1", className)}>
      {isHotfix ? (
        <Badge
          variant="outline"
          className="gap-1 border-red-500/40 bg-red-500/10 px-1.5 text-(length:--text-nano) text-red-700 dark:text-red-300"
        >
          <Flame className="h-3 w-3" />
          HOTFIX
        </Badge>
      ) : null}
      {isBug && !isHotfix ? (
        <Badge
          variant="outline"
          className="gap-1 border-orange-500/40 bg-orange-500/10 px-1.5 text-(length:--text-nano) text-orange-700 dark:text-orange-300"
        >
          <Bug className="h-3 w-3" />
          Bug
        </Badge>
      ) : null}
    </span>
  );
}
