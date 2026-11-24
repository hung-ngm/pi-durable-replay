import type { Context } from "@earendil-works/chord/context";
import {
  AssistantEntry,
  defineDoc,
  LiveDoc,
  ToolResultEntry,
  type CommitPublication,
  type ConversationId,
  type Harness,
  type TaskGraph,
  type TaskId,
} from "@earendil-works/pi-durable";

export type KillReason = "manual" | "budget";
export type BudgetKind = "tokens" | "turns";

/** One run kill, manual (Stop) or fired by a budget. */
export type KillRecord = {
  reason: KillReason;
  /** Set when reason is "budget": which budget fired. */
  budget?: BudgetKind;
  conversationId?: number;
  taskId?: number;
  at: number;
};

export type RunBudgets = {
  /** The generation task that started this run; a different live generation is a new run. */
  taskId: number;
  /** Budgets snapshotted when the guard first saw the run; later edits apply to the next run (SPEC test 8). */
  tokenBudget: number;
  turnBudget: number;
};

export type ControlState = {
  tokenBudget: number;
  turnBudget: number;
  kills: KillRecord[];
  runs: Record<string, RunBudgets>;
};

export const DEFAULT_TOKEN_BUDGET = 100_000;
export const DEFAULT_TURN_BUDGET = 30;

/** Budgets and kill state for this Session (SPEC: ControlDoc). Stored, not derived. */
export const ControlDoc = defineDoc<ControlState>({
  kind: "app.control",
  version: 1,
  scope: "session",
  initial: () => ({
    tokenBudget: DEFAULT_TOKEN_BUDGET,
    turnBudget: DEFAULT_TURN_BUDGET,
    kills: [],
    runs: {},
  }),
  checkpointWhen: (value) => value.kills.length === 0 && Object.keys(value.runs).length === 0,
});

const CONTROL_VIEW_KINDS: ReadonlySet<string> = new Set(["app.control", "app.replay"]);

/** Whether a commit changed a document the Control view is built from. */
export const changesControlView = (publication: CommitPublication): boolean =>
  publication.changes.some(
    (change) => change.type === "document" && CONTROL_VIEW_KINDS.has(change.record.kind),
  );

export async function readControl(harness: Harness, context: Context): Promise<ControlState> {
  const doc = await harness.snapshot(ControlDoc, context);
  if (doc === undefined) {
    return {
      tokenBudget: DEFAULT_TOKEN_BUDGET,
      turnBudget: DEFAULT_TURN_BUDGET,
      kills: [],
      runs: {},
    };
  }
  return {
    tokenBudget: doc.tokenBudget,
    turnBudget: doc.turnBudget,
    kills: doc.kills.map((kill) => ({ ...kill })),
    runs: Object.fromEntries(
      Object.entries(doc.runs).map(([key, run]) => [key, { ...run }]),
    ) as Record<string, RunBudgets>,
  };
}

export async function setBudgets(
  harness: Harness,
  budgets: { tokenBudget: number; turnBudget: number },
  context: Context,
): Promise<void> {
  await harness.commit(async (tx) => {
    const doc = await tx.doc(ControlDoc);
    doc.tokenBudget = budgets.tokenBudget;
    doc.turnBudget = budgets.turnBudget;
  }, context);
}

async function recordKill(harness: Harness, kill: KillRecord, context: Context): Promise<void> {
  await harness.commit(async (tx) => {
    const doc = await tx.doc(ControlDoc);
    doc.kills.push(kill);
  }, context);
}

const LIVE_TASK_STATES = new Set(["pending", "running", "waiting", "sleeping", "completing"]);

/**
 * Kill a run: its generation, or the conversation's live generation when only the
 * conversation is named. The harness aborts the run's owned work bottom-up. Manual
 * and budget kills share this path and the same terminal state; only the recorded
 * reason differs.
 */
export async function kill(
  harness: Harness,
  graph: TaskGraph,
  request: {
    conversationId?: ConversationId;
    taskId?: TaskId;
    reason: KillReason;
    budget?: BudgetKind;
  },
  context: Context,
): Promise<KillRecord> {
  const record: KillRecord = {
    reason: request.reason,
    ...(request.budget === undefined ? {} : { budget: request.budget }),
    ...(request.conversationId === undefined
      ? {}
      : { conversationId: request.conversationId as number }),
    ...(request.taskId === undefined ? {} : { taskId: request.taskId as number }),
    at: Date.now(),
  };
  await recordKill(harness, record, context);

  if (request.taskId !== undefined) {
    await harness.abortTask(request.taskId, context);
    return record;
  }
  if (request.conversationId === undefined) {
    throw new Error("A run kill needs a taskId or a conversationId");
  }
  const generation = Object.values(graph.tasks).find(
    (node) =>
      node.kind === "pi.generation" &&
      node.conversationId === request.conversationId &&
      LIVE_TASK_STATES.has(node.state.status),
  );
  if (generation !== undefined) {
    await harness.abortTask(generation.id as TaskId, context);
  } else {
    const conversation = await harness.conversation(request.conversationId, context);
    await conversation?.abort(context, { background: true });
  }
  return record;
}

type UsageTotals = { tokens: number; turns: number };

/**
 * Usage of one run: the entries of its conversation subtree from the run's first entry on.
 * Entry IDs are session-wide and ascending, so this needs no baseline and cannot miss a
 * response that committed before the guard first saw the run.
 */
async function runUsage(
  harness: Harness,
  rootId: ConversationId,
  context: Context,
): Promise<UsageTotals> {
  return harness.commit(async (tx) => {
    const first = (await tx.doc(LiveDoc, rootId)).run?.first;
    if (first === undefined) return { tokens: 0, turns: 0 };
    const conversations = (await tx.scanConversations({}, 1_000)).items;
    const parentOf = new Map<number, number>();
    for (const conversation of conversations) {
      if (conversation.owner === undefined) continue;
      // Ownership is a task; the parent conversation is that task's conversation.
      const ownerTask = await tx.task(conversation.owner.taskId);
      if (ownerTask !== undefined) {
        parentOf.set(conversation.id as number, ownerTask.conversationId as number);
      }
    }
    const inSubtree = (id: number): boolean => {
      let current: number | undefined = id;
      const seen = new Set<number>();
      while (current !== undefined && !seen.has(current)) {
        if (current === (rootId as number)) return true;
        seen.add(current);
        current = parentOf.get(current);
      }
      return false;
    };
    let tokens = 0;
    let turns = 0;
    for (const conversation of conversations) {
      if (!inSubtree(conversation.id as number)) continue;
      let cursor;
      do {
        const page = await tx.scanEntries({ conversationId: conversation.id }, 100, cursor);
        for (const entry of page.items) {
          if ((entry.id as number) < (first as number)) continue;
          const isAssistant = AssistantEntry.is(entry);
          if (!isAssistant && !ToolResultEntry.is(entry)) continue;
          if (isAssistant) turns += 1;
          for (const message of entry.model ?? []) {
            if ("usage" in message && message.usage !== undefined) {
              tokens += message.usage.totalTokens ?? message.usage.input + message.usage.output;
            }
          }
        }
        cursor = page.next;
      } while (cursor !== undefined);
    }
    return { tokens, turns };
  }, context);
}

/**
 * The budget guard. Called by the Session host whenever the task graph or the commit
 * stream moves. A run is one live generation in an ownerless conversation; its usage
 * is what its conversation subtree spent from the run's first entry on, judged against
 * the budgets snapshotted when the guard first saw the run.
 */
export async function checkBudgets(
  harness: Harness,
  graph: TaskGraph,
  context: Context,
): Promise<readonly KillRecord[]> {
  const control = await readControl(harness, context);
  const liveRuns = new Map<number, number>();
  for (const node of Object.values(graph.tasks)) {
    if (node.kind !== "pi.generation" || !LIVE_TASK_STATES.has(node.state.status)) continue;
    liveRuns.set(node.conversationId as number, node.id as number);
  }
  // Only ownerless conversations host runs; a generation in an owned conversation is
  // part of its root's subtree.
  const conversations = await harness.commit((tx) => tx.scanConversations({}, 1_000), context);
  const ownerless = new Set(
    conversations.items
      .filter((conversation) => conversation.owner === undefined)
      .map((conversation) => conversation.id as number),
  );
  const kills: KillRecord[] = [];

  for (const conversationId of Object.keys(control.runs)) {
    if (!liveRuns.has(Number(conversationId))) {
      await harness.commit(async (tx) => {
        const doc = await tx.doc(ControlDoc);
        delete doc.runs[conversationId];
      }, context);
    }
  }

  for (const [conversationId] of liveRuns) {
    if (!ownerless.has(conversationId)) continue;
    const id = conversationId as ConversationId;
    const taskId = liveRuns.get(conversationId)!;
    const stored = control.runs[String(conversationId)];
    const budgets =
      stored?.taskId === taskId
        ? stored
        : { taskId, tokenBudget: control.tokenBudget, turnBudget: control.turnBudget };
    if (budgets !== stored) {
      await harness.commit(async (tx) => {
        const doc = await tx.doc(ControlDoc);
        doc.runs[String(conversationId)] = budgets;
      }, context);
    }
    const usage = await runUsage(harness, id, context);
    const fired: BudgetKind | undefined =
      usage.tokens > budgets.tokenBudget
        ? "tokens"
        : usage.turns > budgets.turnBudget
          ? "turns"
          : undefined;
    if (fired !== undefined) {
      await harness.commit(async (tx) => {
        const doc = await tx.doc(ControlDoc);
        delete doc.runs[String(conversationId)];
      }, context);
      kills.push(
        await kill(
          harness,
          graph,
          {
            conversationId: id,
            taskId: taskId as TaskId,
            reason: "budget",
            budget: fired,
          },
          context,
        ),
      );
    }
  }
  return kills;
}
