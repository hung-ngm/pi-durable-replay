// Adapted from assistant-ui (https://github.com/assistant-ui/assistant-ui),
// MIT License, Copyright (c) 2026 AgentbaseAI Inc.
import { Collapsible as CollapsiblePrimitive } from "radix-ui";
import type { ComponentProps } from "react";

export function Collapsible(props: ComponentProps<typeof CollapsiblePrimitive.Root>) {
  return <CollapsiblePrimitive.Root data-slot="collapsible" {...props} />;
}

export function CollapsibleTrigger(
  props: ComponentProps<typeof CollapsiblePrimitive.CollapsibleTrigger>,
) {
  return <CollapsiblePrimitive.CollapsibleTrigger data-slot="collapsible-trigger" {...props} />;
}

export function CollapsibleContent(
  props: ComponentProps<typeof CollapsiblePrimitive.CollapsibleContent>,
) {
  return <CollapsiblePrimitive.CollapsibleContent data-slot="collapsible-content" {...props} />;
}
