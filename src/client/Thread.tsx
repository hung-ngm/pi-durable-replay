import {
  ActionBarPrimitive,
  ComposerPrimitive,
  ErrorPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAuiState,
} from "@assistant-ui/react";
import type { ToolDiagnostic } from "@earendil-works/pi-durable";
import type { ComponentProps } from "react";
import { MAX_PROMPT_CHARACTERS } from "../protocol.ts";
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

export function Thread({ conversation, onFork, onReplay, onFillGap }: ThreadProps) {
  return (
    <ThreadPrimitive.Root className="thread">
      <ThreadPrimitive.Viewport
        className="transcript"
        role="log"
        aria-labelledby="transcript-heading"
        tabIndex={0}
        autoScroll
      >
        {conversation === undefined ? (
          <p className="transcript-empty">Loading conversation…</p>
        ) : (
          <ThreadPrimitive.Empty>
            <p className="transcript-empty">
              Send a message to begin. You can fork the conversation from any user or assistant
              message.
            </p>
          </ThreadPrimitive.Empty>
        )}
        {conversation?.hasEarlier === true ? (
          <ThreadPrimitive.LoadEarlier className="text-button transcript-load">
            Load earlier messages
          </ThreadPrimitive.LoadEarlier>
        ) : null}
        <ol className="transcript-list">
          <ThreadPrimitive.Messages>
            {() => (
              <li>
                <Message onFork={onFork} onReplay={onReplay} onFillGap={onFillGap} />
              </li>
            )}
          </ThreadPrimitive.Messages>
        </ol>
        <ThreadPrimitive.ViewportFooter>
          {conversation === undefined || conversation.compactions.length === 0 ? null : (
            <p className="compaction-status" role="status">
              {conversation.compactions.some(({ blocking }) => blocking)
                ? "Compacting context before responding…"
                : "Compacting context in the background…"}
            </p>
          )}
          {conversation === undefined || conversation.queued.length === 0 ? null : (
            <ol className="transcript-list queued-inputs" aria-label="Queued messages">
              {conversation.queued.map((input) => (
                <li key={input.submissionId}>
                  <article className="transcript-message transcript-message--user transcript-message--queued">
                    <header>
                      <div className="transcript-message-title">
                        <strong>User</strong>
                        <span>Queued</span>
                      </div>
                    </header>
                    <MessageText text={input.text} />
                  </article>
                </li>
              ))}
            </ol>
          )}
        </ThreadPrimitive.ViewportFooter>
      </ThreadPrimitive.Viewport>
      <Composer typing={conversation?.typing ?? []} />
    </ThreadPrimitive.Root>
  );
}

function Composer({ typing }: { readonly typing: readonly string[] }) {
  return (
    <ComposerPrimitive.Root className="prompt-bar">
      <label className="visually-hidden" htmlFor="prompt">
        Message
      </label>
      <ComposerPrimitive.Input
        id="prompt"
        name="prompt"
        minRows={3}
        maxRows={12}
        maxLength={MAX_PROMPT_CHARACTERS}
        placeholder="Send a message… (Shift+Enter for a new line)"
        submitMode="enter"
        aria-keyshortcuts="Enter"
      />
      <ThreadPrimitive.If running={false}>
        <ComposerPrimitive.Send>Send</ComposerPrimitive.Send>
      </ThreadPrimitive.If>
      <ThreadPrimitive.If running>
        <ComposerPrimitive.Cancel>Stop run</ComposerPrimitive.Cancel>
      </ThreadPrimitive.If>
      <p className="typing-indicator" aria-live="polite">
        {typingLabel(typing)}
      </p>
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
  if (kind === "gap") return parts;

  const forkable = entryId !== undefined && (kind === "user" || kind === "assistant");
  return (
    <MessagePrimitive.Root
      className={`transcript-message transcript-message--${kind === "note" ? "compaction" : kind}${running ? " transcript-message--live" : ""}`}
      aria-busy={running}
    >
      <header>
        <div
          className="transcript-message-title"
          title={entryId === undefined ? undefined : `Entry (id: ${entryId})`}
        >
          <strong>{kindLabel[kind]}</strong>
          {createdAt === undefined || kind === "failure" ? null : (
            <MessageTime timestamp={createdAt} />
          )}
        </div>
        {forkable ? (
          <ActionBarPrimitive.Root className="message-actions" autohide="never">
            <ActionBarPrimitive.Copy className="text-button">Copy</ActionBarPrimitive.Copy>
            <button
              className="text-button transcript-fork"
              type="button"
              aria-label="Fork from this entry"
              onClick={() => onFork(entryId)}
            >
              Fork
            </button>
            {kind === "assistant" && hasToolCalls ? (
              <button
                className="text-button transcript-fork"
                type="button"
                aria-label="Fork Replay from this entry"
                title="Fork Replay: carry completed tool results forward; unsafe tools need fresh approval"
                onClick={() => onReplay(entryId)}
              >
                Replay
              </button>
            ) : null}
          </ActionBarPrimitive.Root>
        ) : null}
      </header>
      {running && !hasToolCalls ? <Responding /> : null}
      {parts}
      <MessagePrimitive.Error>
        <ErrorPrimitive.Root className="transcript-error" role="alert">
          <ErrorPrimitive.Message />
        </ErrorPrimitive.Root>
      </MessagePrimitive.Error>
    </MessagePrimitive.Root>
  );
}

function Responding() {
  const empty = useAuiState((s) => s.message.content.length === 0);
  return empty ? <p className="responding">Responding…</p> : null;
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
        <p key={index}>{paragraph}</p>
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
