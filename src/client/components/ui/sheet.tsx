// Adapted from assistant-ui (https://github.com/assistant-ui/assistant-ui),
// MIT License, Copyright (c) 2026 AgentbaseAI Inc.
import { XIcon } from "lucide-react";
import { Dialog as SheetPrimitive } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "../../lib/utils.ts";

export const Sheet = SheetPrimitive.Root;
export const SheetTrigger = SheetPrimitive.Trigger;
export const SheetTitle = SheetPrimitive.Title;

export function SheetContent({
  className,
  children,
  ...props
}: ComponentProps<typeof SheetPrimitive.Content>) {
  return (
    <SheetPrimitive.Portal>
      <SheetPrimitive.Overlay className="data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=open]:animate-in fixed inset-0 z-50 bg-black/10 duration-150 motion-reduce:animate-none supports-backdrop-filter:backdrop-blur-xs" />
      <SheetPrimitive.Content
        className={cn(
          "bg-background text-foreground data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left fixed inset-y-0 start-0 z-50 flex h-full w-3/4 max-w-sm flex-col border-e duration-200 ease-in-out motion-reduce:animate-none",
          className,
        )}
        {...props}
      >
        {children}
        <SheetPrimitive.Close className="focus-visible:ring-ring absolute end-3 top-3 grid size-11 cursor-pointer place-items-center rounded-md opacity-70 outline-none hover:opacity-100 focus-visible:ring-2">
          <XIcon aria-hidden className="size-4" />
          <span className="sr-only">Close</span>
        </SheetPrimitive.Close>
      </SheetPrimitive.Content>
    </SheetPrimitive.Portal>
  );
}
