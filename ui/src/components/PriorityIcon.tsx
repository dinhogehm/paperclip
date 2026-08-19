import { useState } from "react";
import { ArrowUp, ArrowDown, Minus, AlertTriangle } from "lucide-react";
import { cn } from "../lib/utils";
import { priorityColor, priorityColorDefault } from "../lib/status-colors";
import {
  ISSUE_PRIORITY_DESCRIPTIONS,
  ISSUE_PRIORITY_VALUES,
  issuePriorityLabel,
  type IssuePriorityValue,
} from "../lib/issue-priority-ui";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";

const priorityConfig: Record<IssuePriorityValue, { icon: typeof ArrowUp; color: string }> = {
  critical: { icon: AlertTriangle, color: priorityColor.critical ?? priorityColorDefault },
  high: { icon: ArrowUp, color: priorityColor.high ?? priorityColorDefault },
  medium: { icon: Minus, color: priorityColor.medium ?? priorityColorDefault },
  low: { icon: ArrowDown, color: priorityColor.low ?? priorityColorDefault },
};

const allPriorities = ISSUE_PRIORITY_VALUES;

interface PriorityIconProps {
  priority: string;
  onChange?: (priority: string) => void;
  className?: string;
  showLabel?: boolean;
}

export function PriorityIcon({ priority, onChange, className, showLabel }: PriorityIconProps) {
  const [open, setOpen] = useState(false);
  const config = priorityConfig[priority as IssuePriorityValue] ?? priorityConfig.medium;
  const label = issuePriorityLabel(priority);
  const Icon = config.icon;

  const icon = (
    <span
      className={cn(
        "inline-flex items-center justify-center shrink-0",
        config.color,
        onChange && !showLabel && "cursor-pointer",
        className
      )}
    >
      <Icon className="h-3.5 w-3.5" />
    </span>
  );

  if (!onChange) return showLabel ? <span className="inline-flex items-center gap-1.5">{icon}<span className="text-sm">{label}</span></span> : icon;

  const trigger = showLabel ? (
    <button
      type="button"
      aria-label={`Change priority (current: ${label})`}
      className="inline-flex min-h-5 items-center gap-1.5 cursor-pointer hover:bg-accent/50 rounded px-1 -mx-1 py-0.5 transition-colors"
    >
      {icon}
      <span className="text-sm">{label}</span>
    </button>
  ) : (
    <button
      type="button"
      data-slot="icon-button"
      aria-label={`Change priority (current: ${label})`}
      className="inline-flex cursor-pointer items-center justify-center rounded-sm focus-visible:outline-none focus-visible:ring-(length:--rad-3) focus-visible:ring-ring"
    >
      {icon}
    </button>
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent className="w-52 p-1" align="start">
        {allPriorities.map((p) => {
          const c = priorityConfig[p];
          const PIcon = c.icon;
          const optionLabel = issuePriorityLabel(p);
          return (
            <Button
              key={p}
              variant="ghost"
              size="sm"
              title={ISSUE_PRIORITY_DESCRIPTIONS[p]}
              className={cn("w-full justify-start gap-2 text-xs", p === priority && "bg-accent")}
              onClick={() => {
                onChange(p);
                setOpen(false);
              }}
            >
              <PIcon className={cn("h-3.5 w-3.5", c.color)} />
              <span className="font-medium">{optionLabel}</span>
              <span className="truncate text-muted-foreground">{ISSUE_PRIORITY_DESCRIPTIONS[p]}</span>
            </Button>
          );
        })}
      </PopoverContent>
    </Popover>
  );
}
