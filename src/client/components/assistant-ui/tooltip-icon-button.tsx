// Adapted from assistant-ui (https://github.com/assistant-ui/assistant-ui),
// MIT License, Copyright (c) 2026 AgentbaseAI Inc.
import type { ComponentProps } from "react";
import { cn } from "../../lib/utils.ts";
import { Button } from "../ui/button.tsx";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../ui/tooltip.tsx";

export type TooltipIconButtonProps = ComponentProps<typeof Button> & {
  readonly tooltip: string;
  readonly side?: "top" | "bottom" | "left" | "right";
};

export function TooltipIconButton({
  children,
  tooltip,
  side = "bottom",
  className,
  ...rest
}: TooltipIconButtonProps) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label={tooltip}
            {...rest}
            className={cn("size-6 p-1 active:scale-90 motion-reduce:active:scale-100", className)}
          >
            {children}
          </Button>
        </TooltipTrigger>
        <TooltipContent side={side}>{tooltip}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
