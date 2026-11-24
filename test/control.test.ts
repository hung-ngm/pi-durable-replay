import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, type AssistantMessage } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type FauxResponseStep,
} from "@earendil-works/pi-ai";
import {
  type CommitPublication,
  Harness,
  MemoryStorage,
  type TaskGraph,
} from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { createAgentHarnessOptions } from "../src/agent.ts";
import { changesControlView, checkBudgets, kill, readControl, setBudgets } from "../src/control.ts";

const context = BACKGROUND_CONTEXT;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function openAgent(responses: readonly FauxResponseStep[]) {
  const faux = fauxProvider();
  faux.setResponses([...responses]);
  const models = createModels();
  models.setProvider(faux.provider);
  const options = createAgentHarnessOptions();
  const harness = await Harness.open(new MemoryStorage(), { ...options, models }, context);
  const root = await harness.root(context);
  await root.configure({ model: { provider: "faux", modelId: "faux-1" } }, context);
  const watch = await harness.watchTaskGraph(context);
  watch.start(async () => {});
  return { harness, root, graph: () => watch.value };
}

async function poll<T>(read: () => T | undefined, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("poll timed out");
    await sleep(10);
  }
}

// The task graph only ever holds live tasks; terminal tasks leave the graph.
const liveNodes = (graph: TaskGraph) => Object.values(graph.tasks);

const withUsage = (message: AssistantMessage, totalTokens: number): AssistantMessage => {
  message.usage = {
    input: 0,
    output: totalTokens,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  return message;
};

describe("control: kills and budgets (SPEC tests 1, 2, 8)", () => {
  it("test 1: a manual run kill during loop_forever ends the run and everything it owns", async () => {
    const loopCall = fauxAssistantMessage([fauxToolCall("loop_forever", { topic: "kill" })], {
      stopReason: "toolUse",
    });
    const { harness, root, graph } = await openAgent(Array.from({ length: 400 }, () => loopCall));
    try {
      const submission = await root.submit({ type: "input", content: "Loop forever" }, context);
      await poll(() =>
        Object.values(graph().tasks).find(
          (node) => node.kind === "pi.tool" && node.state.status === "running",
        ),
      );
      const record = await kill(
        harness,
        graph(),
        { conversationId: root.id, reason: "manual" },
        context,
      );
      expect(record).toMatchObject({ reason: "manual" });

      const settled = await submission.wait(context);
      expect(settled.status).not.toBe("done");
      await poll(() => (liveNodes(graph()).length === 0 ? true : undefined));
      const control = await readControl(harness, context);
      expect(control.kills).toHaveLength(1);
      expect(control.kills[0]).toMatchObject({ reason: "manual" });
    } finally {
      await harness.close(context);
    }
  }, 60_000);

  it("test 2: loop_forever is budget-killed on turns, and the kill names the budget", async () => {
    const loopCall = fauxAssistantMessage([fauxToolCall("loop_forever", { topic: "growth" })], {
      stopReason: "toolUse",
    });
    const { harness, root, graph } = await openAgent(Array.from({ length: 400 }, () => loopCall));
    try {
      await setBudgets(harness, { tokenBudget: 100_000_000, turnBudget: 5 }, context);
      const submission = await root.submit({ type: "input", content: "Loop forever" }, context);
      void submission;
      let budgetKill;
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        await checkBudgets(harness, graph(), context);
        const control = await readControl(harness, context);
        budgetKill = control.kills.find((entry) => entry.reason === "budget");
        if (budgetKill !== undefined) break;
        await sleep(50);
      }
      expect(budgetKill).toMatchObject({
        reason: "budget",
        budget: "turns",
      });

      await poll(() => (liveNodes(graph()).length === 0 ? true : undefined), 30_000);
      const count = async () =>
        (await harness.commit((tx) => tx.scanConversations({}, 1_000), context)).items.length;
      const settledCount = await count();
      await sleep(800);
      expect(await count()).toBe(settledCount);
    } finally {
      await harness.close(context);
    }
  }, 60_000);

  it("test 8: budget edits apply to the next run only; the in-flight run keeps its snapshot", async () => {
    // Only the root conversation loops; each recruited child answers once and stops,
    // so the children cannot drain the scripted responses that run 2 needs.
    const step: FauxResponseStep = (transcript) =>
      JSON.stringify(transcript).includes("Call the loop_forever tool")
        ? fauxAssistantMessage("child done")
        : withUsage(
            fauxAssistantMessage([fauxToolCall("loop_forever", { topic: "budgets" })], {
              stopReason: "toolUse",
            }),
            5_000,
          );
    const { harness, root, graph } = await openAgent(Array.from({ length: 400 }, () => step));
    try {
      await setBudgets(harness, { tokenBudget: 100_000_000, turnBudget: 1_000 }, context);

      // Run 1 starts under the generous budgets; the guard snapshots them.
      const first = await root.submit({ type: "input", content: "First run" }, context);
      await poll(() => Object.values(graph().tasks).find((node) => node.kind === "pi.generation"));
      await checkBudgets(harness, graph(), context);
      await poll(() =>
        Object.values(graph().tasks).find(
          (node) => node.kind === "pi.tool" && node.state.status === "running",
        ),
      );

      // Budgets shrink mid-run; run 1 keeps its snapshot and is not killed.
      await setBudgets(harness, { tokenBudget: 1, turnBudget: 1_000 }, context);
      await checkBudgets(harness, graph(), context);
      expect((await readControl(harness, context)).kills).toHaveLength(0);
      await kill(harness, graph(), { conversationId: root.id, reason: "manual" }, context);
      await first.wait(context);
      await poll(() => (liveNodes(graph()).length === 0 ? true : undefined));

      // Run 2 starts under the new budgets; its first response alone crosses the token budget.
      // The guard first sees run 2 only after that response committed, and still counts it.
      const second = await root.submit({ type: "input", content: "Second run" }, context);
      void second;
      await poll(() =>
        Object.values(graph().tasks).find(
          (node) => node.kind === "pi.tool" && node.state.status === "running",
        ),
      );
      await checkBudgets(harness, graph(), context);
      const control = await readControl(harness, context);
      const budgetKill = control.kills.find((entry) => entry.reason === "budget");
      expect(budgetKill).toMatchObject({ reason: "budget", budget: "tokens" });
    } finally {
      await harness.close(context);
    }
  }, 60_000);
});

describe("control view freshness", () => {
  it("counts a budget write as a Control view change, and a conversation setting as not", async () => {
    const harness = await Harness.open(new MemoryStorage(), createAgentHarnessOptions(), context);
    const published: CommitPublication[] = [];
    harness.observeCommits({
      advance: (publication) => published.push(publication),
      end: () => {},
    });
    try {
      const root = await harness.root(context);
      published.length = 0;
      await root.configure({ thinkingLevel: "low" }, context);
      expect(published.some(changesControlView)).toBe(false);

      published.length = 0;
      await setBudgets(harness, { tokenBudget: 500, turnBudget: 5 }, context);
      expect(published.some(changesControlView)).toBe(true);
    } finally {
      await harness.close(context);
    }
  });
});
