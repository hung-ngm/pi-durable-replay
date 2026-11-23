import type { MouseEvent, ReactNode, Ref } from "react";
import type { BlockedReason, TaskGraph, TaskGraphNode } from "@earendil-works/pi-durable";
import { Button } from "./components/ui/button.tsx";

interface ActivityPanelProps {
  readonly className: string;
  readonly graph: TaskGraph | undefined;
  readonly activeConversationId: number | undefined;
  readonly onClose: () => void;
  readonly closeButtonRef?: Ref<HTMLButtonElement>;
  readonly onOpenConversation: (conversationId: number) => void;
}

const blockedReasons: Record<BlockedReason, string> = {
  missing_task: "Blocked · no installed task definition",
  task_too_old: "Blocked · task definition too old",
  migration_failed: "Blocked · task migration failed",
};

const taskStatus = (node: TaskGraphNode): string => {
  const state = node.state;
  switch (state.status) {
    case "pending":
      return `Pending · ${state.phase}`;
    case "running":
      return `Running · ${state.phase}`;
    case "sleeping":
      return state.until === undefined
        ? `Sleeping · ${state.phase}`
        : `Sleeping until ${new Date(state.until).toLocaleString()} · ${state.phase}`;
    case "waiting":
      return `Waiting for ${state.on.map((id) => `#${id}`).join(", ")} · ${state.policy === "failFast" ? "fail fast" : "all settled"}`;
    case "completing":
      return `Finishing · ${state.outcome}`;
  }
};

export function ActivityPanel({
  className,
  graph,
  activeConversationId,
  onClose,
  closeButtonRef,
  onOpenConversation,
}: ActivityPanelProps) {
  const nodes = Object.values(graph?.tasks ?? {}).sort((left, right) => left.id - right.id);
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const children = new Map<number, TaskGraphNode[]>();
  const roots: TaskGraphNode[] = [];

  for (const node of nodes) {
    const directOwner = node.owner === undefined ? undefined : nodesById.get(node.owner);
    const conversationOwner =
      directOwner === undefined
        ? nodes.find((candidate) => candidate.conversations.includes(node.conversationId))
        : undefined;
    const parent = directOwner ?? conversationOwner;
    if (parent === undefined || parent.id === node.id) {
      roots.push(node);
      continue;
    }
    const siblings = children.get(parent.id) ?? [];
    siblings.push(node);
    children.set(parent.id, siblings);
  }

  const followConversation = (event: MouseEvent<HTMLAnchorElement>, conversationId: number) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
      return;
    event.preventDefault();
    onOpenConversation(conversationId);
  };

  const conversationLink = (conversationId: number, label: string) => (
    <a
      href={`?conversation=${conversationId}`}
      aria-current={conversationId === activeConversationId ? "page" : undefined}
      onClick={(event) => followConversation(event, conversationId)}
    >
      {label}
    </a>
  );

  const task = (node: TaskGraphNode): ReactNode => {
    const owned = children.get(node.id) ?? [];
    return (
      <li key={node.id}>
        <article className="grid min-w-0 gap-1.5 border-b pb-3 [&_a]:[overflow-wrap:anywhere]">
          <header className="flex items-baseline justify-between gap-3">
            <strong className="font-medium [overflow-wrap:anywhere]">{node.kind}</strong>
            <span className="text-muted-foreground flex-none text-sm tabular-nums">#{node.id}</span>
          </header>
          <p className="text-muted-foreground text-sm">{taskStatus(node)}</p>
          {node.blocked === undefined ? null : (
            <p className="text-sm font-semibold">{blockedReasons[node.blocked]}</p>
          )}
          <p className="text-sm">
            {conversationLink(node.conversationId, `Conversation #${node.conversationId}`)}
            {node.owner === undefined ? null : ` · Owner task #${node.owner}`}
          </p>
          {node.background || node.abortRequested ? (
            <ul
              className="flex flex-wrap gap-1.5 text-sm [&>li]:rounded-sm [&>li]:border [&>li]:px-1.5 [&>li]:py-0.5"
              aria-label="Task flags"
            >
              {node.background ? <li>Background</li> : null}
              {node.abortRequested ? <li>Aborting</li> : null}
            </ul>
          ) : null}
          {node.conversations.length === 0 ? null : (
            <p className="text-sm">
              Owns{" "}
              {node.conversations.map((conversationId, index) => (
                <span key={conversationId}>
                  {index === 0 ? null : ", "}
                  {conversationLink(conversationId, `conversation #${conversationId}`)}
                </span>
              ))}
            </p>
          )}
        </article>
        {owned.length === 0 ? null : (
          <ol
            className="ms-2.5 mt-2 grid gap-2 border-s ps-4"
            aria-label={`Children of task ${node.id}`}
          >
            {owned.map(task)}
          </ol>
        )}
      </li>
    );
  };

  const countLabel = `${nodes.length} active task${nodes.length === 1 ? "" : "s"}`;
  return (
    <aside className={className} id="activity-panel" aria-labelledby="activity-heading">
      <header className="flex items-center justify-between gap-4 border-b p-4">
        <div>
          <h2 id="activity-heading">Activity</h2>
          <p className="text-muted-foreground text-sm">{countLabel}</p>
        </div>
        <Button ref={closeButtonRef} variant="ghost" className="min-h-11" onClick={onClose}>
          Close
        </Button>
      </header>
      <div className="min-h-0 overflow-y-auto overscroll-contain p-4">
        {graph === undefined ? (
          <p className="text-muted-foreground text-sm">Loading activity…</p>
        ) : roots.length === 0 ? (
          <p className="text-muted-foreground text-sm">No active tasks</p>
        ) : (
          <ol className="grid gap-3" aria-label="Active task graph">
            {roots.map(task)}
          </ol>
        )}
      </div>
    </aside>
  );
}
