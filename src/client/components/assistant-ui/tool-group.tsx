// Adapted from assistant-ui (https://github.com/assistant-ui/assistant-ui),
// MIT License, Copyright (c) 2026 AgentbaseAI Inc.
import { LoaderIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/utils.ts";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible.tsx";
import {
  DisclosureChevron,
  disclosureContent,
  disclosureTrigger,
  useFollowedOpen,
} from "./tool-fallback.tsx";

export function ToolGroup({
  count,
  active,
  failed,
  children,
}: {
  readonly count: number;
  readonly active: boolean;
  readonly failed: boolean;
  readonly children: ReactNode;
}) {
  const [open, setOpen] = useFollowedOpen(active || failed);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="w-full" aria-busy={active}>
      <CollapsibleTrigger className={disclosureTrigger}>
        {active ? (
          <LoaderIcon
            aria-hidden
            className="size-4 shrink-0 animate-spin [animation-duration:0.6s] motion-reduce:animate-none"
          />
        ) : null}
        <span className={cn("leading-none", active && "shimmer motion-reduce:animate-none")}>
          {count} tool calls
        </span>
        <DisclosureChevron />
      </CollapsibleTrigger>
      <CollapsibleContent className={disclosureContent}>
        <div className="border-border ms-2 flex flex-col border-0 border-s border-solid ps-3">
          {children}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
