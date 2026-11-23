// Adapted from projection.ts in usecontextlayer/pi-durable-assistant-ui
// (https://github.com/usecontextlayer/pi-durable-assistant-ui), MIT License,
// Copyright (c) 2026 usecontextlayer.
import type { ThreadMessageLike } from "@assistant-ui/react";
import type { AssistantMessage, Message, ToolResultMessage } from "@earendil-works/pi-ai";
import type {
  EntryRecord,
  LiveState,
  RunFailure,
  ToolDiagnostic,
  TranscriptView,
} from "@earendil-works/pi-durable";
import { CompactionEntry, ResetEntry, ToolResultEntry } from "@earendil-works/pi-durable";
import { REPLAY_BLOCK_MARKER } from "../protocol.ts";
import type { ReplayState } from "../replay.ts";

type Part = Exclude<ThreadMessageLike["content"], string>[number];
type ToolPart = Extract<Part, { readonly type: "tool-call" }>;
type Status = NonNullable<ThreadMessageLike["status"]>;

export interface PiMessage extends ThreadMessageLike {
  readonly id: string;
  readonly content: readonly Part[];
  readonly metadata: {
    readonly custom: {
      readonly conversationId: number;
      readonly entryId?: number;
      readonly taskId?: number;
    };
  };
}

export interface ToolArtifact {
  readonly details?: unknown;
  readonly diagnostics?: readonly ToolDiagnostic[];
}

type Draft = { -readonly [K in keyof PiMessage]: PiMessage[K] } & { content: Part[] };

const RUN_FAILURE_REASONS: Record<RunFailure["reason"], string> = {
  model_error: "The model request failed",
  no_model: "No model is available",
  aborted: "The run was aborted",
  reset: "The context was reset",
  faulted: "The run faulted",
  orphaned: "The run's task cannot run here",
  interrupted: "The server stopped while the model was answering",
  restart_limit: "The run was cut off too often",
  nothing_to_answer: "There was nothing to answer",
  turn_limit: "The run reached its tool round limit",
};

export const liveStateOf = (view: TranscriptView): LiveState =>
  (view.docs["pi.live"] ?? {}) as unknown as LiveState;

export function projectConversation(
  view: TranscriptView,
  previous: readonly PiMessage[] = [],
): readonly PiMessage[] {
  const conversationId = view.conversation.id;
  const live = liveStateOf(view);
  const running = live.run !== undefined;
  const messages: Draft[] = [];
  const calls = new Map<string, { message: Draft; index: number }>();

  const addToolCall = (message: Draft, part: ToolPart): void => {
    calls.set(part.toolCallId ?? "", { message, index: message.content.length });
    message.content.push(part);
  };

  const updateToolCall = (callId: string, update: (part: ToolPart) => ToolPart): boolean => {
    const slot = calls.get(callId);
    if (slot === undefined) return false;
    slot.message.content[slot.index] = update(slot.message.content[slot.index] as ToolPart);
    return true;
  };

  const assistantDraft = (
    id: string,
    message: AssistantMessage,
    custom: PiMessage["metadata"]["custom"],
    status: Status,
  ): Draft => {
    const draft: Draft = {
      id,
      role: "assistant",
      content: [],
      status,
      createdAt: new Date(message.timestamp),
      metadata: { custom },
    };
    for (const part of message.content) {
      if (part.type === "text") {
        if (part.text.length > 0) draft.content.push({ type: "text", text: part.text });
      } else if (part.type === "thinking") {
        draft.content.push({ type: "reasoning", text: part.thinking });
      } else {
        addToolCall(draft, {
          type: "tool-call",
          toolCallId: part.id,
          toolName: part.name,
          args: part.arguments as ToolPart["args"],
        });
      }
    }
    return draft;
  };

  const gaps = new Map<number, number>();
  for (const item of view.items) if (item.kind === "gap") gaps.set(item.after, item.upTo);

  for (const item of view.items) {
    if (item.kind !== "entry") continue;
    const entry = item.entry;
    const custom = { conversationId, entryId: entry.id };

    if (CompactionEntry.is(entry) || ResetEntry.is(entry)) {
      const first = entry.model?.[0];
      const text = first === undefined ? "" : messageText(first);
      messages.push({
        id: `entry:${entry.id}:notice`,
        role: "assistant",
        content: [
          {
            type: "data-pi-context",
            data: CompactionEntry.is(entry)
              ? { kind: "compaction", text: compactionSummary(text) }
              : { kind: "reset", text: text || "Context reset" },
          },
        ],
        status: { type: "complete", reason: "unknown" },
        metadata: { custom },
      });
    } else if (ToolResultEntry.is(entry) && entry.model?.[0]?.role === "toolResult") {
      const result = entry.model[0];
      const diagnostics = toolResultDiagnostics(entry.data);
      const apply = (part: ToolPart): ToolPart => ({
        ...part,
        result: toolResultText(result, diagnostics.length > 0),
        isError: result.isError,
        ...(result.details === undefined && diagnostics.length === 0
          ? {}
          : {
              artifact: {
                ...(result.details === undefined ? {} : { details: result.details }),
                ...(diagnostics.length === 0 ? {} : { diagnostics }),
              } satisfies ToolArtifact,
            }),
      });
      if (!updateToolCall(result.toolCallId, apply)) {
        const orphan: Draft = {
          id: `entry:${entry.id}:0`,
          role: "assistant",
          content: [],
          status: { type: "complete", reason: "stop" },
          metadata: { custom },
        };
        addToolCall(
          orphan,
          apply({
            type: "tool-call",
            toolCallId: result.toolCallId,
            toolName: result.toolName,
            args: {},
          }),
        );
        messages.push(orphan);
      }
    } else {
      for (const [index, message] of (entry.model ?? []).entries()) {
        const id = `entry:${entry.id}:${index}`;
        if (message.role === "assistant") {
          messages.push(assistantDraft(id, message, custom, messageStatus(message)));
        } else if (message.role === "user" || message.role === "system") {
          messages.push({
            id,
            role: message.role,
            content: [{ type: "text", text: messageText(message) }],
            createdAt: new Date(message.timestamp),
            metadata: { custom },
          });
        }
      }
      if ((entry.model ?? []).length === 0) {
        messages.push({
          id: `entry:${entry.id}:notice`,
          role: "assistant",
          content: [
            {
              type: "data-pi-event",
              data: {
                kind: entry.kind,
                text: entry.data === undefined ? entry.kind : JSON.stringify(entry.data),
              },
            },
          ],
          status: { type: "complete", reason: "unknown" },
          metadata: { custom },
        });
      }
    }

    const upTo = gaps.get(entry.id);
    if (upTo !== undefined) {
      messages.push({
        id: `gap:${entry.id}`,
        role: "assistant",
        content: [{ type: "data-pi-gap", data: { kind: "gap", after: entry.id, upTo } }],
        status: { type: "complete", reason: "unknown" },
        metadata: { custom: { conversationId } },
      });
    }
  }

  for (const message of messages) {
    if (message.status?.type === "incomplete") continue;
    const unresolved = message.content.some(
      (part) => part.type === "tool-call" && part.result === undefined,
    );
    if (unresolved) {
      message.status = running ? { type: "running" } : { type: "incomplete", reason: "cancelled" };
    }
  }

  const taskId = live.run?.taskId;
  const partial = live.generation?.message as AssistantMessage | undefined;
  if (partial !== undefined) {
    const draft = assistantDraft(
      `generation:${taskId ?? conversationId}`,
      partial,
      { conversationId, ...(taskId === undefined ? {} : { taskId }) },
      { type: "running" },
    );
    const retry = live.generation?.retry;
    if (retry !== undefined) draft.content.push({ type: "data-pi-retry", data: retry });
    messages.push(draft);
  }

  for (const slot of live.tools ?? []) {
    if (slot.status === "done") continue;
    const progress = (part: ToolPart): ToolPart => ({
      ...part,
      ...(slot.output === undefined ? {} : { result: slot.output }),
      isPreliminary: true,
      artifact: {
        ...(slot.details === undefined ? {} : { details: slot.details }),
        ...(slot.diagnostics === undefined ? {} : { diagnostics: slot.diagnostics }),
      } satisfies ToolArtifact,
    });
    if (updateToolCall(slot.callId, progress)) {
      const owner = calls.get(slot.callId);
      if (owner !== undefined) owner.message.status = { type: "running" };
      continue;
    }
    const draft: Draft = {
      id: `tool:${slot.callId}`,
      role: "assistant",
      content: [],
      status: { type: "running" },
      metadata: { custom: { conversationId, ...(taskId === undefined ? {} : { taskId }) } },
    };
    addToolCall(
      draft,
      progress({ type: "tool-call", toolCallId: slot.callId, toolName: slot.name, args: {} }),
    );
    messages.push(draft);
  }

  const failure = failureMessage(live, conversationId);
  if (failure !== undefined) messages.push(failure);

  return reuseUnchanged(messages, previous);
}

function failureMessage(live: LiveState, conversationId: number): Draft | undefined {
  const run = live.runFailure;
  const compaction = live.compactionFailure;
  if (run === undefined && compaction === undefined) return undefined;
  const reason = run === undefined ? undefined : (RUN_FAILURE_REASONS[run.reason] ?? run.reason);
  const error =
    run === undefined
      ? `Compaction failed: ${compaction?.error ?? ""}`
      : run.detail === undefined
        ? (reason ?? "")
        : `${reason}: ${run.detail}`;
  const taskId = run?.taskId ?? compaction?.taskId ?? 0;
  return {
    id: `failure:${taskId}`,
    role: "assistant",
    content: [],
    status: { type: "incomplete", reason: "error", error },
    metadata: { custom: { conversationId, taskId } },
  };
}

function reuseUnchanged(
  next: readonly Draft[],
  previous: readonly PiMessage[],
): readonly PiMessage[] {
  if (previous.length === 0) return next;
  const before = new Map(previous.map((message) => [message.id, message]));
  return next.map((message) => {
    const prior = before.get(message.id);
    return prior !== undefined && sameMessage(prior, message) ? prior : message;
  });
}

const sameMessage = (left: PiMessage, right: PiMessage): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

function messageStatus(message: AssistantMessage): Status {
  if (message.stopReason === "error") {
    return {
      type: "incomplete",
      reason: "error",
      error: message.errorMessage ?? "Model request failed",
    };
  }
  if (message.stopReason === "aborted") return { type: "incomplete", reason: "cancelled" };
  if (message.stopReason === "length") return { type: "incomplete", reason: "length" };
  return { type: "complete", reason: "stop" };
}

/** Compaction entries wrap the summary in the Harness's fixed `<summary>` framing. */
function compactionSummary(text: string): string {
  return /<summary>\n([\s\S]*)\n<\/summary>$/.exec(text)?.[1] ?? text;
}

/** Tool result content ends with a rendered `<harness>` block whenever the entry carries diagnostics. */
function toolResultText(message: ToolResultMessage, hasDiagnostics: boolean): string {
  const parts = hasDiagnostics ? message.content.slice(0, -1) : message.content;
  return contentText(parts);
}

const DIAGNOSTIC_SEVERITIES: ReadonlySet<unknown> = new Set(["info", "warn", "error"]);

function toolResultDiagnostics(data: EntryRecord["data"]): readonly ToolDiagnostic[] {
  if (!isRecord(data) || !Array.isArray(data.diagnostics)) return [];
  return data.diagnostics.filter(
    (value): value is ToolDiagnostic =>
      isRecord(value) &&
      DIAGNOSTIC_SEVERITIES.has(value.severity) &&
      typeof value.message === "string" &&
      (value.code === undefined || typeof value.code === "string"),
  );
}

function messageText(message: Message): string {
  switch (message.role) {
    case "system": {
      const sections = Object.values(message.sections ?? {}).filter(
        (value): value is string => typeof value === "string",
      );
      return [contentText(message.content), ...sections].filter(Boolean).join("\n\n");
    }
    case "assistant":
      return contentText(message.content) || message.errorMessage || "";
    default:
      return contentText(message.content);
  }
}

const isBlockedCall = (part: Part): part is ToolPart =>
  part.type === "tool-call" &&
  part.isError === true &&
  ((part.artifact ?? {}) as ToolArtifact).diagnostics?.some(
    ({ code, message }) => code === "blocked" && message.includes(REPLAY_BLOCK_MARKER),
  ) === true;

export function withReplayApproval(
  messages: readonly PiMessage[],
  conversationId: number,
  replay: ReplayState | undefined,
): readonly PiMessage[] {
  if (replay === undefined) return messages;
  const approval = {
    id: `replay:${conversationId}`,
    approved: replay.approvedAt === undefined ? undefined : true,
  };
  return messages.map((message) =>
    message.content.some(isBlockedCall)
      ? {
          ...message,
          content: message.content.map((part) =>
            isBlockedCall(part) ? { ...part, approval } : part,
          ),
        }
      : message,
  );
}

export function contentText(content: string | readonly unknown[]): string {
  if (typeof content === "string") return content;
  return content
    .map((part) => {
      if (!isRecord(part)) return "";
      if (part.type === "text" && typeof part.text === "string") return part.text;
      if (part.type === "image") return "[Image]";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
