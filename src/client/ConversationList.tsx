import { ThreadListItemPrimitive, ThreadListPrimitive } from "@assistant-ui/react";
import { Button } from "./components/ui/button.tsx";

export function ConversationList({ disabled }: { readonly disabled: boolean }) {
  return (
    <nav className="flex flex-col gap-2 px-4 pb-4" aria-labelledby="conversations-heading">
      <h2 id="conversations-heading">Conversations</h2>
      <ThreadListPrimitive.Root className="flex flex-col gap-2">
        <ThreadListPrimitive.New asChild>
          <Button variant="outline" size="sm" disabled={disabled}>
            New conversation
          </Button>
        </ThreadListPrimitive.New>
        <div className="flex flex-col gap-0.5">
          <ThreadListPrimitive.Items components={{ ThreadListItem: ConversationItem }} />
        </div>
      </ThreadListPrimitive.Root>
    </nav>
  );
}

function ConversationItem() {
  return (
    <ThreadListItemPrimitive.Root className="hover:bg-muted data-active:bg-muted has-focus-visible:bg-muted flex min-h-8 items-center rounded-md transition-colors data-active:font-medium">
      <ThreadListItemPrimitive.Trigger className="focus-visible:ring-ring/50 flex h-full min-h-8 min-w-0 flex-1 cursor-pointer items-center rounded-md px-2.5 text-start text-sm outline-none focus-visible:ring-2">
        <ThreadListItemPrimitive.Title fallback="Conversation" />
      </ThreadListItemPrimitive.Trigger>
    </ThreadListItemPrimitive.Root>
  );
}
