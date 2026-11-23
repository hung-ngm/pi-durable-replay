import {
  ActionBarPrimitive,
  AuiIf,
  ComposerPrimitive,
  ErrorPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAuiState,
} from "@assistant-ui/react";
import type { ToolDiagnostic } from "@earendil-works/pi-durable";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CheckIcon,
  CopyIcon,
  GitForkIcon,
  RotateCcwIcon,
  SquareIcon,
  TriangleAlertIcon,
} from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { MAX_PROMPT_CHARACTERS } from "../protocol.ts";
import { TooltipIconButton } from "./components/assistant-ui/tooltip-icon-button.tsx";
import { cn } from "./lib/utils.ts";
import type { ToolArtifact } from "./projection.ts";
import type { ConversationSnapshot, TranscriptGap } from "./session-state.ts";

type PartState = Parameters<
  Extract<ComponentProps<typeof MessagePrimitive.Parts>["children"], (...args: never) => unknown>
>[0]["part"];
type ToolCallPart = Extract<PartState, { readonly type: "tool-call" }>;

interface ThreadProps {
  readonly conversation: ConversationSnapshot | undefined;
  readonly onFork: (entryId: number) => void;
  readonly onReplay: (entryId: number) => void;
  readonly onFillGap: (gap: TranscriptGap) => void;
}

const column = "mx-auto w-full max-w-[44rem] px-4";

export function Thread({ conversation, onFork, onReplay, onFillGap }: ThreadProps) {
  return (
    <ThreadPrimitive.Root className="bg-background flex min-h-0 flex-col">
      <ThreadPrimitive.Viewport
        className="relative flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain"
        role="log"
        aria-labelledby="transcript-heading"
        tabIndex={0}
        autoScroll
      >
        <div className={cn(column, "flex flex-1 flex-col pt-4")}>
          {conversation === undefined ? (
            <p className="text-muted-foreground my-auto text-center">Loading conversation…</p>
          ) : (
            <ThreadPrimitive.Empty>
              <div className="fade-in animate-in my-auto py-8 text-center duration-300 motion-reduce:animate-none">
                <p className="m-0 text-2xl font-medium tracking-tight">How can I help you today?</p>
                <p className="text-muted-foreground m-0 mt-2 text-sm">
                  Send a message to begin. You can fork the conversation from any user or assistant
                  message.
                </p>
              </div>
            </ThreadPrimitive.Empty>
          )}
          {conversation?.hasEarlier === true ? (
            <ThreadPrimitive.LoadEarlier className="text-muted-foreground hover:bg-accent mb-6 cursor-pointer self-center rounded-full border-0 bg-transparent px-3 py-1.5 text-sm">
              Load earlier messages
            </ThreadPrimitive.LoadEarlier>
          ) : null}
          <ol className="m-0 mb-8 flex list-none flex-col gap-y-6 p-0">
            <ThreadPrimitive.Messages>
              {() => (
                <li>
                  <Message onFork={onFork} onReplay={onReplay} onFillGap={onFillGap} />
                </li>
              )}
            </ThreadPrimitive.Messages>
          </ol>
          <ThreadPrimitive.ViewportFooter className="mt-auto flex flex-col gap-3 pb-4">
            {conversation === undefined || conversation.compactions.length === 0 ? null : (
              <p className="text-muted-foreground m-0 text-center text-sm" role="status">
                {conversation.compactions.some(({ blocking }) => blocking)
                  ? "Compacting context before responding…"
                  : "Compacting context in the background…"}
              </p>
            )}
            {conversation === undefined || conversation.queued.length === 0 ? null : (
              <ol
                className="m-0 flex list-none flex-col items-end gap-2 p-0"
                aria-label="Queued messages"
              >
                {conversation.queued.map((input) => (
                  <li
                    key={input.submissionId}
                    className="bg-muted/60 text-muted-foreground max-w-[80%] rounded-2xl px-4 py-2"
                  >
                    <span className="mb-1 block text-xs font-medium">Queued</span>
                    <MessageText text={input.text} />
                  </li>
                ))}
              </ol>
            )}
          </ThreadPrimitive.ViewportFooter>
        </div>
      </ThreadPrimitive.Viewport>
      <div className={cn(column, "relative flex flex-col gap-1 pb-4 md:pb-6")}>
        <ThreadPrimitive.ScrollToBottom asChild>
          <TooltipIconButton
            tooltip="Scroll to bottom"
            variant="outline"
            className="dark:bg-background dark:hover:bg-accent absolute -top-12 z-10 size-9 self-center rounded-full border p-2 disabled:invisible"
          >
            <ArrowDownIcon />
          </TooltipIconButton>
        </ThreadPrimitive.ScrollToBottom>
        <Composer />
        <p className="text-muted-foreground m-0 min-h-4 px-2 text-xs" aria-live="polite">
          {typingLabel(conversation?.typing ?? [])}
        </p>
      </div>
    </ThreadPrimitive.Root>
  );
}

function Composer() {
  return (
    <ComposerPrimitive.Root className="border-foreground/10 focus-within:border-foreground/25 focus-within:ring-ring/50 flex w-full flex-col gap-2 rounded-2xl border border-solid bg-[color-mix(in_oklab,var(--color-muted)_30%,transparent)] p-2 transition-[border-color] focus-within:ring-2">
      <label className="sr-only" htmlFor="prompt">
        Message
      </label>
      <ComposerPrimitive.Input
        id="prompt"
        name="prompt"
        minRows={1}
        maxRows={8}
        maxLength={MAX_PROMPT_CHARACTERS}
        placeholder="Send a message… (Shift+Enter for a new line)"
        submitMode="enter"
        enterKeyHint="send"
        aria-keyshortcuts="Enter"
        className="caret-primary placeholder:text-muted-foreground/60 text-foreground max-h-48 min-h-10 w-full resize-none border-0 bg-transparent px-2.5 py-1 font-[inherit] text-base leading-6 outline-none"
      />
      <div className="flex items-center justify-end gap-1.5">
        <AuiIf condition={(s) => !s.thread.isRunning}>
          <ComposerPrimitive.Send asChild>
            <TooltipIconButton
              tooltip="Send message"
              variant="default"
              className="size-7 rounded-full"
            >
              <ArrowUpIcon className="size-4" />
            </TooltipIconButton>
          </ComposerPrimitive.Send>
        </AuiIf>
        <AuiIf condition={(s) => s.thread.isRunning}>
          <ComposerPrimitive.Cancel asChild>
            <TooltipIconButton tooltip="Kill run" variant="default" className="size-7 rounded-full">
              <SquareIcon className="size-3.5 fill-current" />
            </TooltipIconButton>
          </ComposerPrimitive.Cancel>
        </AuiIf>
      </div>
    </ComposerPrimitive.Root>
  );
}

const typingLabel = (usernames: readonly string[]): string => {
  if (usernames.length === 1) return `${usernames[0]} is typing…`;
  if (usernames.length === 2) return `${usernames[0]}, ${usernames[1]} are typing…`;
  return usernames.length > 2 ? "Many are typing…" : "";
};

type MessageKind = "user" | "assistant" | "system" | "note" | "gap" | "failure";

const messageKind = (id: string, role: string): MessageKind => {
  if (id.startsWith("gap:")) return "gap";
  if (id.startsWith("failure:")) return "failure";
  if (id.endsWith(":notice")) return "note";
  return role === "user" ? "user" : role === "system" ? "system" : "assistant";
};

const kindLabel: Record<MessageKind, string> = {
  user: "User",
  assistant: "Assistant",
  system: "System",
  note: "Context",
  gap: "",
  failure: "Run ended",
};

const entrance =
  "fade-in slide-in-from-bottom-1 animate-in duration-150 motion-reduce:animate-none";

function Message({ onFork, onReplay, onFillGap }: Omit<ThreadProps, "conversation">) {
  const id = useAuiState((s) => s.message.id);
  const role = useAuiState((s) => s.message.role);
  const createdAt = useAuiState((s) => s.message.createdAt);
  const entryId = useAuiState((s) => s.message.metadata.custom.entryId as number | undefined);
  const running = useAuiState((s) => s.message.status?.type === "running");
  const hasToolCalls = useAuiState((s) =>
    s.message.content.some((part) => part.type === "tool-call"),
  );
  const kind = messageKind(id, role);

  const parts = (
    <MessagePrimitive.Parts>
      {({ part }) => <Part part={part} onFillGap={onFillGap} />}
    </MessagePrimitive.Parts>
  );
  if (kind === "gap") return <div className="flex justify-center">{parts}</div>;

  const forkable = entryId !== undefined && (kind === "user" || kind === "assistant");
  const heading = (
    <span className="sr-only" title={entryId === undefined ? undefined : `Entry (id: ${entryId})`}>
      {kindLabel[kind]}
    </span>
  );
  const footer = (
    <MessageFooter align={kind === "user" ? "end" : "start"}>
      {createdAt === undefined || kind === "failure" ? null : <MessageTime timestamp={createdAt} />}
      {forkable ? (
        <MessageActions
          onFork={() => onFork(entryId)}
          onReplay={kind === "assistant" && hasToolCalls ? () => onReplay(entryId) : undefined}
        />
      ) : null}
    </MessageFooter>
  );

  if (kind === "user") {
    return (
      <MessagePrimitive.Root
        className={cn("group grid grid-cols-[minmax(72px,1fr)_auto] gap-y-1 px-2", entrance)}
      >
        {heading}
        <div className="bg-muted text-foreground col-start-2 min-w-0 rounded-2xl px-4 py-2 break-words">
          {parts}
        </div>
        <div className="col-start-2">{footer}</div>
      </MessagePrimitive.Root>
    );
  }

  return (
    <MessagePrimitive.Root
      className={cn(
        "group px-2 leading-relaxed break-words",
        kind === "system" || kind === "note" ? "text-muted-foreground text-sm" : "text-foreground",
        entrance,
      )}
      aria-busy={running}
    >
      {kind === "assistant" ? (
        heading
      ) : (
        <p className="m-0 mb-1 text-xs font-medium tracking-wide uppercase">{kindLabel[kind]}</p>
      )}
      {running && !hasToolCalls ? <Responding /> : null}
      <div className="flex flex-col gap-2">{parts}</div>
      <MessagePrimitive.Error>
        <ErrorPrimitive.Root
          className="border-destructive bg-destructive/10 text-destructive mt-2 flex items-center gap-3 rounded-md border border-solid p-3 text-sm dark:text-red-200"
          role="alert"
        >
          <TriangleAlertIcon className="size-4 shrink-0" aria-hidden />
          <ErrorPrimitive.Message className="min-w-0 flex-1" />
        </ErrorPrimitive.Root>
      </MessagePrimitive.Error>
      {kind === "assistant" ? footer : null}
    </MessagePrimitive.Root>
  );
}

function MessageFooter({
  align,
  children,
}: {
  readonly align: "start" | "end";
  readonly children: ReactNode;
}) {
  const isLast = useAuiState((s) => s.message.isLast);
  return (
    <div
      className={cn(
        "text-muted-foreground flex min-h-7 items-center gap-2 pt-1 text-xs transition-opacity motion-reduce:transition-none",
        align === "end" && "justify-end",
        !isLast && "opacity-0 group-focus-within:opacity-100 group-hover:opacity-100",
      )}
    >
      {children}
    </div>
  );
}

function MessageActions({
  onFork,
  onReplay,
}: {
  readonly onFork: () => void;
  readonly onReplay: (() => void) | undefined;
}) {
  return (
    <ActionBarPrimitive.Root autohide="never" hideWhenRunning className="-ms-1 flex gap-1">
      <ActionBarPrimitive.Copy asChild>
        <TooltipIconButton tooltip="Copy">
          <AuiIf condition={(s) => s.message.isCopied}>
            <CheckIcon />
          </AuiIf>
          <AuiIf condition={(s) => !s.message.isCopied}>
            <CopyIcon />
          </AuiIf>
        </TooltipIconButton>
      </ActionBarPrimitive.Copy>
      <TooltipIconButton tooltip="Fork" aria-label="Fork from this entry" onClick={onFork}>
        <GitForkIcon />
      </TooltipIconButton>
      {onReplay === undefined ? null : (
        <TooltipIconButton
          tooltip="Fork Replay: carry completed tool results forward; unsafe tools need fresh approval"
          aria-label="Fork Replay from this entry"
          onClick={onReplay}
        >
          <RotateCcwIcon />
        </TooltipIconButton>
      )}
    </ActionBarPrimitive.Root>
  );
}

function Responding() {
  const empty = useAuiState((s) => s.message.content.length === 0);
  return empty ? (
    <p className="text-muted-foreground m-0 animate-pulse motion-reduce:animate-none">
      Responding…
    </p>
  ) : null;
}

function Part({
  part,
  onFillGap,
}: {
  readonly part: PartState;
  readonly onFillGap: (gap: TranscriptGap) => void;
}) {
  switch (part.type) {
    case "text":
      return <MessageText text={part.text} />;
    case "reasoning":
      return (
        <details className="reasoning">
          <summary>Thinking</summary>
          <MessageText text={part.text} />
        </details>
      );
    case "tool-call":
      return <ToolCard part={part} />;
    case "data":
      return <DataPart name={part.name} data={part.data} onFillGap={onFillGap} />;
    default:
      return null;
  }
}

function DataPart({
  name,
  data,
  onFillGap,
}: {
  readonly name: string;
  readonly data: unknown;
  readonly onFillGap: (gap: TranscriptGap) => void;
}) {
  switch (name) {
    case "pi-gap":
      return (
        <button
          className="text-button transcript-load"
          type="button"
          onClick={() => onFillGap(data as TranscriptGap)}
        >
          Load missing messages
        </button>
      );
    case "pi-context": {
      const note = data as { readonly kind: "compaction" | "reset"; readonly text: string };
      return (
        <>
          <p className="context-kind">
            {note.kind === "compaction" ? "Context summary" : "Context reset"}
          </p>
          <MessageText text={note.text} />
        </>
      );
    }
    case "pi-event": {
      const event = data as { readonly kind: string; readonly text: string };
      return <MessageText text={event.text} />;
    }
    case "pi-retry": {
      const retry = data as { readonly error: string };
      return <p role="status">Retrying: {retry.error}</p>;
    }
    default:
      return null;
  }
}

type ToolDisplayStatus = "waiting" | "running" | "completed" | "failed" | "cancelled";

const toolStatusLabel: Record<ToolDisplayStatus, string> = {
  waiting: "Waiting",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  cancelled: "No result",
};

function toolDisplayStatus(part: ToolCallPart): ToolDisplayStatus {
  if (part.result !== undefined && part.isPreliminary !== true) {
    return part.isError === true ? "failed" : "completed";
  }
  switch (part.status.type) {
    case "running":
      return part.isPreliminary === true ? "running" : "waiting";
    case "incomplete":
      return part.status.reason === "error" ? "failed" : "cancelled";
    case "requires-action":
      return "waiting";
    default:
      return "completed";
  }
}

function ToolCard({ part }: { readonly part: ToolCallPart }) {
  const status = toolDisplayStatus(part);
  const artifact = (part.artifact ?? {}) as ToolArtifact;
  const output = typeof part.result === "string" ? part.result : undefined;
  return (
    <article
      className={`tool-execution tool-execution--${status}`}
      aria-busy={status === "waiting" || status === "running"}
    >
      <header>
        <strong>{part.toolName}</strong>
        <span className="tool-status">{toolStatusLabel[status]}</span>
      </header>
      {Object.keys(part.args).length === 0 ? null : (
        <details>
          <summary>Arguments</summary>
          <pre>{JSON.stringify(part.args, null, 2)}</pre>
        </details>
      )}
      {output === undefined || output.length === 0 ? null : <MessageText text={output} />}
      {artifact.details === undefined ? null : (
        <details>
          <summary>Details</summary>
          <pre>{JSON.stringify(artifact.details, null, 2)}</pre>
        </details>
      )}
      {artifact.diagnostics === undefined || artifact.diagnostics.length === 0 ? null : (
        <Diagnostics diagnostics={artifact.diagnostics} />
      )}
    </article>
  );
}

function Diagnostics({ diagnostics }: { readonly diagnostics: readonly ToolDiagnostic[] }) {
  return (
    <ul className="diagnostics">
      {diagnostics.map((diagnostic, index) => (
        <li key={`${diagnostic.code ?? "diagnostic"}-${index}`}>
          <strong>{capitalize(diagnostic.severity)}</strong>: {diagnostic.message}
        </li>
      ))}
    </ul>
  );
}

function MessageText({ text }: { readonly text: string }) {
  return (
    <>
      {text.split(/\n{2,}/).map((paragraph, index) => (
        <p key={index} className="m-0 [overflow-wrap:anywhere] whitespace-pre-wrap [&+p]:mt-3">
          {paragraph}
        </p>
      ))}
    </>
  );
}

function MessageTime({ timestamp }: { readonly timestamp: Date }) {
  return (
    <time dateTime={timestamp.toISOString()} title={formatAbsoluteTime(timestamp)}>
      {formatMessageTime(timestamp)}
    </time>
  );
}

const formatMessageTime = (timestamp: Date): string => {
  const now = new Date();
  const isToday =
    timestamp.getDate() === now.getDate() &&
    timestamp.getMonth() === now.getMonth() &&
    timestamp.getFullYear() === now.getFullYear();
  return timestamp.toLocaleString(undefined, {
    ...(isToday ? {} : { month: "short", day: "numeric" }),
    hour: "numeric",
    minute: "2-digit",
  });
};

const formatAbsoluteTime = (timestamp: Date): string =>
  timestamp.toLocaleString(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });

const capitalize = (value: string): string =>
  value.length === 0 ? value : value[0].toUpperCase() + value.slice(1);
