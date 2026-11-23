import type { Context } from "@earendil-works/chord/context";
import {
  defineDoc,
  hook,
  ToolResultEntry,
  ToolTask,
  type ConversationId,
  type EntryId,
  type Harness,
} from "@earendil-works/pi-durable";
import { CHARGE_CREDITS_TOOL_NAME, LedgerDoc } from "./tools.ts";

export type CarriedToolResult = {
  callId: string;
  name: string;
};

export type ReplayState = {
  sourceConversationId: number;
  forkEntryId: number;
  /** Tool results committed before the fork point, carried forward as history. */
  carried: CarriedToolResult[];
  /** True when the source conversation charged and no approval is recorded yet. */
  pendingUnsafeApproval: boolean;
  approvedAt?: number;
};

/**
 * Provenance of a Fork Replay, stored on the forked conversation (SPEC: ReplayDoc).
 * `fork: "initial"` means an ordinary fork starts with no ReplayDoc; only a Fork
 * Replay writes one.
 */
export const ReplayDoc = defineDoc<ReplayState>({
  kind: "app.replay",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({
    sourceConversationId: 0,
    forkEntryId: 0,
    carried: [],
    pendingUnsafeApproval: false,
  }),
  checkpointWhen: () => true,
});

export type ForkReplayResult = {
  readonly conversationId: ConversationId;
  readonly carried: readonly CarriedToolResult[];
  readonly pendingUnsafeApproval: boolean;
};

/**
 * Fork Replay: fork the source conversation at `entryId` (the entry before the
 * failure), and write the ReplayDoc naming the source, the fork entry, and every
 * tool result carried forward. Carried results are history in the fork, so the safe
 * tools behind them never run again. The approval gate arms from the ledger, not
 * from the carried results: a charge whose result was never committed, or sits
 * after the fork point, still happened, and the fork must not repeat it unasked.
 */
export async function replayFork(
  harness: Harness,
  sourceConversationId: ConversationId,
  entryId: EntryId,
  context: Context,
): Promise<ForkReplayResult> {
  return harness.commit(async (tx) => {
    const carried: CarriedToolResult[] = [];
    let cursor;
    do {
      const page = await tx.scanEntries({ conversationId: sourceConversationId }, 100, cursor);
      for (const entry of page.items) {
        if ((entry.id as number) > (entryId as number)) continue;
        if (!ToolResultEntry.is(entry)) continue;
        const message = entry.model?.[0];
        if (message?.role === "toolResult") {
          carried.push({ callId: message.toolCallId, name: message.toolName });
        }
      }
      cursor = page.next;
    } while (cursor !== undefined);
    carried.reverse();

    const fork = await tx.forkConversation(sourceConversationId, entryId, {
      ownership: { kind: "ownerless" },
    });
    const ledger = await tx.doc(LedgerDoc);
    const pendingUnsafeApproval = ledger.entries.some(
      (entry) => entry.conversationId === (sourceConversationId as number),
    );
    const doc = await tx.doc(ReplayDoc, fork.id);
    doc.sourceConversationId = sourceConversationId as number;
    doc.forkEntryId = entryId as number;
    doc.carried = carried;
    doc.pendingUnsafeApproval = pendingUnsafeApproval;
    return { conversationId: fork.id, carried, pendingUnsafeApproval };
  }, context);
}

/** Read a conversation's ReplayDoc, or undefined when it is not a Fork Replay. */
export async function readReplay(
  harness: Harness,
  conversationId: ConversationId,
  context: Context,
): Promise<ReplayState | undefined> {
  const snapshot = await harness.snapshot(ReplayDoc, conversationId, context);
  if (snapshot === undefined || snapshot.sourceConversationId === 0) return undefined;
  return {
    sourceConversationId: snapshot.sourceConversationId,
    forkEntryId: snapshot.forkEntryId,
    carried: snapshot.carried.map((entry) => ({ ...entry })),
    pendingUnsafeApproval: snapshot.pendingUnsafeApproval,
    ...(snapshot.approvedAt === undefined ? {} : { approvedAt: snapshot.approvedAt }),
  };
}

/** Record the operator's fresh approval for unsafe tools in a fork. Durable: asked once, approved once. */
export async function approveUnsafe(
  harness: Harness,
  conversationId: ConversationId,
  context: Context,
): Promise<void> {
  await harness.commit(async (tx) => {
    const doc = await tx.doc(ReplayDoc, conversationId);
    doc.pendingUnsafeApproval = false;
    doc.approvedAt = Date.now();
  }, context);
}

/**
 * The approval gate: a beforeTool hook on every tool call. In a Fork Replay whose
 * source conversation charged, charge_credits is blocked until the operator approves
 * it (approveUnsafe). The approval is durable in the ReplayDoc, so a crash never asks
 * twice; the block is the ask, and the Control Panel is where it is answered.
 */
export const unsafeGateHook = hook(ToolTask, {
  beforeTool: async (call, api, context) => {
    if (call.name !== CHARGE_CREDITS_TOOL_NAME) return undefined;
    const replay = await api.snapshot(ReplayDoc, api.conversationId, context);
    if (replay === undefined || !replay.pendingUnsafeApproval) return undefined;
    return {
      block:
        `${call.name} is blocked in this replay: conversation #${replay.sourceConversationId} ` +
        "already charged, so a charge here needs fresh approval. " +
        "The operator can approve it in the Control Panel.",
    };
  },
});
