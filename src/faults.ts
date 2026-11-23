import type { Context } from "@earendil-works/chord/context";
import {
  defineDoc,
  type ConversationId,
  type Harness,
  type TaskId,
} from "@earendil-works/pi-durable";

export type FaultState = {
  /** Conversation where the crash-loop fault is armed, if any. */
  crashLoopConversationId?: number;
  /** How many times the host has cut the object off for the crash loop. */
  aborts: number;
  lastAbortAt?: number;
  /** CrashDoc attempts at the last cut: the host only cuts a fresh execution. */
  attemptsAtLastAbort?: number;
};

/**
 * Durable fault-injection state (session-scoped). The crash-loop arm must survive
 * the very evictions it causes, so it lives in a doc, not in host memory.
 */
export const FaultDoc = defineDoc<FaultState>({
  kind: "app.fault",
  version: 1,
  scope: "session",
  initial: () => ({ aborts: 0 }),
  checkpointWhen: (value) => value.crashLoopConversationId === undefined,
});

export async function readFaults(harness: Harness, context: Context): Promise<FaultState> {
  const snapshot = await harness.snapshot(FaultDoc, context);
  return {
    aborts: snapshot?.aborts ?? 0,
    ...(snapshot?.attemptsAtLastAbort === undefined
      ? {}
      : { attemptsAtLastAbort: snapshot.attemptsAtLastAbort }),
    ...(snapshot?.crashLoopConversationId === undefined
      ? {}
      : { crashLoopConversationId: snapshot.crashLoopConversationId }),
    ...(snapshot?.lastAbortAt === undefined ? {} : { lastAbortAt: snapshot.lastAbortAt }),
  };
}

export async function armCrashLoop(
  harness: Harness,
  conversationId: ConversationId,
  context: Context,
): Promise<void> {
  await harness.commit(async (tx) => {
    const doc = await tx.doc(FaultDoc);
    doc.crashLoopConversationId = conversationId as number;
    doc.aborts = 0;
    delete doc.lastAbortAt;
    delete doc.attemptsAtLastAbort;
  }, context);
}

export async function clearCrashLoop(harness: Harness, context: Context): Promise<void> {
  await harness.commit(async (tx) => {
    const doc = await tx.doc(FaultDoc);
    delete doc.crashLoopConversationId;
    delete doc.lastAbortAt;
    delete doc.attemptsAtLastAbort;
  }, context);
}

/** Record a crash-loop cut-off of the execution counted by `attempts`. */
export async function noteCrashLoopAbort(
  harness: Harness,
  attempts: number,
  context: Context,
): Promise<number> {
  return harness.commit(async (tx) => {
    const doc = await tx.doc(FaultDoc);
    doc.aborts += 1;
    doc.lastAbortAt = Date.now();
    doc.attemptsAtLastAbort = attempts;
    return doc.aborts;
  }, context);
}

/**
 * Find a live tool task in a conversation by the tool's name. The graph and the
 * task records carry call IDs, not names; the name lives in the assistant entry
 * that made the call, so this joins the two inside one commit.
 */
export async function findLiveToolTask(
  harness: Harness,
  conversationId: ConversationId,
  toolName: string,
  context: Context,
): Promise<TaskId | undefined> {
  return harness.commit(async (tx) => {
    const scanned = await tx.scanTasks({ conversationId, kind: "pi.tool" }, 200);
    // A task record is live until its state carries an outcome.
    const candidates = scanned.items.filter((task) => task.state.outcome === undefined);
    if (candidates.length === 0) return undefined;
    const callIds = new Map<string, TaskId>();
    for (const task of candidates) {
      const input = task.input as { kind?: string; callId?: string } | undefined;
      if (input?.kind === "model" && typeof input.callId === "string") {
        callIds.set(input.callId, task.id);
      }
    }
    if (callIds.size === 0) return undefined;
    let cursor;
    do {
      const page = await tx.scanEntries({ conversationId }, 100, cursor);
      for (const entry of page.items) {
        for (const message of entry.model ?? []) {
          if (message.role !== "assistant") continue;
          for (const block of message.content) {
            if (block.type === "toolCall" && block.name === toolName && callIds.has(block.id)) {
              return callIds.get(block.id);
            }
          }
        }
      }
      cursor = page.next;
    } while (cursor !== undefined);
    return undefined;
  }, context);
}

/** True when the conversation's history holds a tool result for `toolName` mentioning `needle`. */
export async function conversationHasToolResult(
  harness: Harness,
  conversationId: ConversationId,
  toolName: string,
  needle: string,
  context: Context,
): Promise<boolean> {
  return harness.commit(async (tx) => {
    let cursor;
    do {
      const page = await tx.scanEntries({ conversationId }, 100, cursor);
      for (const entry of page.items) {
        for (const message of entry.model ?? []) {
          if (message.role !== "toolResult" || message.toolName !== toolName) continue;
          if (JSON.stringify(entry).includes(needle)) return true;
        }
      }
      cursor = page.next;
    } while (cursor !== undefined);
    return false;
  }, context);
}
