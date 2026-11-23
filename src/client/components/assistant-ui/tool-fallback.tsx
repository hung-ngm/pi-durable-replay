// Adapted from assistant-ui (https://github.com/assistant-ui/assistant-ui),
// MIT License, Copyright (c) 2026 AgentbaseAI Inc.
import {
  ChevronDownIcon,
  CheckIcon,
  CircleAlertIcon,
  LoaderIcon,
  XCircleIcon,
  type LucideIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { cn } from "../../lib/utils.ts";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible.tsx";

export type ToolRowStatus =
  | "waiting"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "blocked";

const rowLabel: Record<ToolRowStatus, string> = {
  waiting: "Waiting on tool",
  running: "Running tool",
  completed: "Used tool",
  failed: "Failed tool",
  cancelled: "Cancelled tool",
  blocked: "Blocked tool",
};

const rowIcon: Record<ToolRowStatus, LucideIcon> = {
  waiting: CircleAlertIcon,
  running: LoaderIcon,
  completed: CheckIcon,
  failed: XCircleIcon,
  cancelled: XCircleIcon,
  blocked: CircleAlertIcon,
};

export const disclosureTrigger =
  "group/trigger text-muted-foreground hover:text-foreground focus-visible:ring-ring flex w-fit max-w-full cursor-pointer items-center gap-2 rounded-sm py-1.5 text-sm outline-none transition-[color,scale] focus-visible:ring-2 active:scale-[0.98] motion-reduce:transition-none motion-reduce:active:scale-100";

export const disclosureContent =
  "overflow-hidden data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down motion-reduce:animate-none";

export function DisclosureChevron({ className }: { readonly className?: string }) {
  return (
    <ChevronDownIcon
      aria-hidden
      className={cn(
        "size-4 shrink-0 -rotate-90 transition-transform duration-200 group-data-[state=open]/trigger:rotate-0 motion-reduce:transition-none",
        className,
      )}
    />
  );
}

export function useFollowedOpen(wanted: boolean) {
  const [open, setOpen] = useState(wanted);
  const [followed, setFollowed] = useState(wanted);
  if (wanted !== followed) {
    setFollowed(wanted);
    setOpen(wanted);
  }
  return [open, setOpen] as const;
}

export function ToolFallback({
  toolName,
  note,
  status,
  children,
}: {
  readonly toolName: string;
  readonly note?: string | undefined;
  readonly status: ToolRowStatus;
  readonly children: ReactNode;
}) {
  const [open, setOpen] = useFollowedOpen(status !== "completed" && status !== "cancelled");
  const busy = status === "waiting" || status === "running";
  const Icon = rowIcon[status];
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="w-full" aria-busy={busy}>
      <CollapsibleTrigger className={disclosureTrigger}>
        <Icon
          aria-hidden
          className={cn(
            "size-4 shrink-0",
            status === "running" &&
              "animate-spin [animation-duration:0.6s] motion-reduce:animate-none",
            status === "failed" && "text-destructive",
          )}
        />
        <span
          className={cn(
            "min-w-0 text-start leading-none [overflow-wrap:anywhere]",
            status === "cancelled" && "line-through",
            busy && "shimmer motion-reduce:animate-none",
          )}
        >
          {rowLabel[status]}: <b>{toolName}</b>
          {note === undefined ? null : <span className="text-xs"> · {note}</span>}
        </span>
        <DisclosureChevron />
      </CollapsibleTrigger>
      <CollapsibleContent className={cn(disclosureContent, "text-sm")}>
        <div className="flex flex-col gap-2 ps-6 pt-1 pb-2">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function ToolBlock({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <div>
      <p className="text-muted-foreground m-0 text-xs font-medium">{label}</p>
      <pre className="bg-muted/50 text-foreground/90 m-0 mt-1 max-h-80 overflow-auto rounded-md p-2.5 font-mono text-xs [overflow-wrap:anywhere] whitespace-pre-wrap">
        {children}
      </pre>
    </div>
  );
}
