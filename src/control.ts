import type { Context } from "@earendil-works/chord/context";
import {
  AssistantEntry,
  defineDoc,
  UsageDoc,
  type ConversationId,
  type Harness,
  type TaskGraph,
  type TaskId,
} from "@earendil-works/pi-durable";

export type AbortScope = "run" | "tool" | "conversation" | "all";
export type KillReason = "manual" | "budget";
export type BudgetKind = "tokens" | "turns";

export type KillRecord = {
  scope: AbortScope;
  reason: KillReason;
  /** Set when reason is "budget": which budget fired. */
  budget?: BudgetKind;
  conversationId?: number;
  taskId?: number;
  at: number;
};

export type RunBaseline = {
  /** The generation task that started this run; a different live generation is a new run. */
  taskId: number;
  tokensAtStart: number;
  turnsAtStart: number;
  /** Budgets snapshotted when the run started; later edits apply to the next run (SPEC test 8). */
  tokenBudget: number;
  turnBudget: number;
};

export type ControlState = {
  tokenBudget: number;
  turnBudget: number;
  kills: KillRecord[];
  runs: Record<string, RunBaseline>;
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

export async function readControl(harness: Harness, context: Context): Promise<ControlState> {
  return harness.commit(async (tx) => {
    const doc = await tx.doc(ControlDoc);
    return {
      tokenBudget: doc.tokenBudget,
      turnBudget: doc.turnBudget,
      kills: doc.kills.map((kill) => ({ ...kill })),
      runs: Object.fromEntries(
        Object.entries(doc.runs).map(([key, run]) => [key, { ...run }]),
      ) as Record<string, RunBaseline>,
    };
  }, context);
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
 * Kill, by Abort Scope. The harness aborts a scope's owned tasks bottom-up, and each
 * owned task's own abort handling runs before its parent settles. Manual and budget
 * kills share this path and the same terminal state; only the recorded reason differs.
 */
export async function kill(
  harness: Harness,
  graph: TaskGraph,
  request: {
    scope: AbortScope;
    conversationId?: ConversationId;
    taskId?: TaskId;
    reason: KillReason;
    budget?: BudgetKind;
  },
  context: Context,
): Promise<KillRecord> {
  const record: KillRecord = {
    scope: request.scope,
    reason: request.reason,
    ...(request.budget === undefined ? {} : { budget: request.budget }),
    ...(request.conversationId === undefined
      ? {}
      : { conversationId: request.conversationId as number }),
    ...(request.taskId === undefined ? {} : { taskId: request.taskId as number }),
    at: Date.now(),
  };
  await recordKill(harness, record, context);

  switch (request.scope) {
    case "tool": {
      if (request.taskId === undefined) throw new Error("A tool kill needs a taskId");
      await harness.abortTask(request.taskId, context);
      break;
    }
    case "run": {
      if (request.taskId !== undefined) {
        await harness.abortTask(request.taskId, context);
        break;
      }
      if (request.conversationId === undefined)
        throw new Error("A run kill needs a taskId or a conversationId");
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
      break;
    }
    case "conversation": {
      if (request.conversationId === undefined)
        throw new Error("A conversation kill needs a conversationId");
      const conversation = await harness.conversation(request.conversationId, context);
      await conversation?.abort(context, { background: true });
      break;
    }
    case "all": {
      const conversations = await harness.commit((tx) => tx.scanConversations({}, 1_000), context);
      for (const conversation of conversations.items) {
        if (conversation.owner !== undefined) continue;
        const handle = await harness.conversation(conversation.id, context);
        await handle?.abort(context, { background: true });
      }
      break;
    }
  }
  return record;
}

type UsageTotals = { tokens: number; turns: number };

/** Usage of one conversation subtree: the conversation plus every conversation owned beneath it. */
async function subtreeUsage(
  harness: Harness,
  rootId: ConversationId,
  context: Context,
): Promise<UsageTotals> {
  return harness.commit(async (tx) => {
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
      const usage = await tx.doc(UsageDoc, conversation.id);
      for (const bucket of [usage.models, usage.tools]) {
        for (const entry of Object.values(bucket)) {
          tokens += entry.totalTokens ?? entry.input + entry.output;
        }
      }
      let cursor;
      do {
        const page = await tx.scanEntries({ conversationId: conversation.id }, 100, cursor);
        for (const entry of page.items) {
          if (AssistantEntry.is(entry)) turns += 1;
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
 * is its conversation subtree's usage minus the baseline taken when the run started,
 * judged against the budgets snapshotted at that same moment.
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
    const usage = await subtreeUsage(harness, id, context);
    const baseline = control.runs[String(conversationId)];
    if (baseline === undefined || baseline.taskId !== liveRuns.get(conversationId)) {
      await harness.commit(async (tx) => {
        const doc = await tx.doc(ControlDoc);
        doc.runs[String(conversationId)] = {
          taskId: liveRuns.get(conversationId)!,
          tokensAtStart: usage.tokens,
          turnsAtStart: usage.turns,
          tokenBudget: doc.tokenBudget,
          turnBudget: doc.turnBudget,
        };
      }, context);
      continue;
    }
    const tokensUsed = usage.tokens - baseline.tokensAtStart;
    const turnsUsed = usage.turns - baseline.turnsAtStart;
    const fired: BudgetKind | undefined =
      tokensUsed > baseline.tokenBudget
        ? "tokens"
        : turnsUsed > baseline.turnBudget
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
          { scope: "conversation", conversationId: id, reason: "budget", budget: fired },
          context,
        ),
      );
    }
  }
  return kills;
}
