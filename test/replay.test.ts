import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type FauxResponseStep,
} from "@earendil-works/pi-ai";
import {
  type ConversationId,
  Harness,
  MemoryStorage,
  type TaskGraph,
} from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { createAgentHarnessOptions } from "../src/agent.ts";
import { kill } from "../src/control.ts";
import { approveUnsafe, readReplay, replayFork } from "../src/replay.ts";

const context = BACKGROUND_CONTEXT;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function poll<T>(read: () => Promise<T | undefined> | T | undefined, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("poll timed out");
    await sleep(10);
  }
}

const loopCall = () =>
  fauxAssistantMessage([fauxToolCall("loop_forever", { topic: "growth" })], {
    stopReason: "toolUse",
  });

/**
 * One scripted model for every conversation. A user turn asking to research gets a
 * search, any other user turn and a search result get a loop_forever call, and a
 * loop_forever result (blocked or aborted) ends the turn. Recruited loop children
 * answer once, so they never drain the script.
 */
const scripted: FauxResponseStep = (transcript) => {
  const last = transcript.messages[transcript.messages.length - 1];
  if (JSON.stringify(transcript).includes("Call the loop_forever tool")) {
    return fauxAssistantMessage("child done");
  }
  if (last?.role === "user") {
    return JSON.stringify(last.content).includes("Research")
      ? fauxAssistantMessage([fauxToolCall("search", { query: "durable execution" })], {
          stopReason: "toolUse",
        })
      : loopCall();
  }
  if (last?.role === "toolResult" && last.toolName === "search") return loopCall();
  return fauxAssistantMessage([fauxText("Stopped.")]);
};

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
  return { harness, root, graph: () => watch.value as TaskGraph };
}

describe("replay (SPEC test 4)", () => {
  it("test 4: Fork Replay carries safe results forward and does not run them again", async () => {
    const { harness, root } = await openAgent([
      // Run 1: two safe searches complete, then the provider fails.
      fauxAssistantMessage(
        [
          fauxToolCall("search", { query: "durable execution" }),
          fauxToolCall("search", { query: "exactly once" }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("provider exploded", {
        stopReason: "error",
        errorMessage: "provider exploded",
      }),
      // Fork run: the model answers from the carried results.
      fauxAssistantMessage([fauxText("Report from the carried searches.")]),
    ]);
    try {
      const first = await root.submit(
        { type: "input", content: "Research durable execution." },
        context,
      );
      await first.wait(context);

      // Fork at the newest committed entry: everything the failed run committed.
      const forkEntryId = await harness.commit(async (tx) => {
        const page = await tx.scanEntries({ conversationId: root.id }, 100);
        return page.items[0]?.id ?? 0;
      }, context);

      const fork = await replayFork(harness, root.id, forkEntryId, context);
      expect(fork.carried.map((entry) => entry.name)).toEqual(["search", "search"]);
      const replay = await readReplay(harness, fork.conversationId, context);
      expect(replay?.sourceConversationId).toBe(root.id as number);

      const forkConversation = await harness.conversation(fork.conversationId, context);
      if (forkConversation === undefined) throw new Error("fork conversation missing");
      await forkConversation.configure({ model: { provider: "faux", modelId: "faux-1" } }, context);
      const forkRun = await forkConversation.submit(
        { type: "input", content: "Finish the report." },
        context,
      );
      expect((await forkRun.wait(context)).status).toBe("done");

      // The two searches were carried as history and never re-fired.
      const forkToolTasks = await harness.commit(async (tx) => {
        const page = await tx.scanTasks(
          { conversationId: fork.conversationId, kind: "pi.tool" },
          200,
        );
        return page.items.length;
      }, context);
      expect(forkToolTasks).toBe(0);
    } finally {
      await harness.close(context);
    }
  }, 60_000);

  it("gates loop_forever in a fork of a conversation that looped, until the operator approves", async () => {
    const { harness, root, graph } = await openAgent(Array.from({ length: 200 }, () => scripted));
    const toolTasksIn = (conversationId: ConversationId) =>
      harness.commit(
        async (tx) =>
          (
            await tx.scanTasks(
              { conversationId: conversationId as ConversationId, kind: "pi.tool" },
              200,
            )
          ).items.length,
        context,
      );
    const conversationCount = async () =>
      (await harness.commit((tx) => tx.scanConversations({}, 1_000), context)).items.length;
    try {
      // Source: search, then a runaway loop that the operator stops.
      const source = await root.submit({ type: "input", content: "Research, then loop." }, context);
      await poll(async () => ((await conversationCount()) > 1 ? true : undefined));
      await kill(harness, graph(), { conversationId: root.id, reason: "manual" }, context);
      await source.wait(context);

      // Fork right after the search result, before the loop_forever call.
      const searchResultId = await harness.commit(async (tx) => {
        const page = await tx.scanEntries({ conversationId: root.id }, 100);
        return page.items.find((entry) =>
          (entry.model ?? []).some((m) => m.role === "toolResult" && m.toolName === "search"),
        )?.id;
      }, context);
      if (searchResultId === undefined) throw new Error("search result entry missing");
      const fork = await replayFork(harness, root.id, searchResultId, context);
      expect(fork.carried.map((entry) => entry.name)).toEqual(["search"]);
      expect(fork.pendingUnsafeApproval).toBe(true);

      const forkConversation = await harness.conversation(fork.conversationId, context);
      if (forkConversation === undefined) throw new Error("fork conversation missing");
      await forkConversation.configure({ model: { provider: "faux", modelId: "faux-1" } }, context);

      // Blocked: the fork's loop_forever call recruits nothing, and search does not run again.
      const before = await conversationCount();
      const blockedRun = await forkConversation.submit(
        { type: "input", content: "Go on." },
        context,
      );
      expect((await blockedRun.wait(context)).status).toBe("done");
      expect(await conversationCount()).toBe(before);
      expect(await toolTasksIn(fork.conversationId)).toBe(1);

      // Approved: the next loop_forever call runs and recruits a subagent conversation.
      await approveUnsafe(harness, fork.conversationId, context);
      const approvedRun = await forkConversation.submit(
        { type: "input", content: "Go on." },
        context,
      );
      await poll(async () => ((await conversationCount()) > before ? true : undefined));
      await kill(
        harness,
        graph(),
        { conversationId: fork.conversationId, reason: "manual" },
        context,
      );
      await approvedRun.wait(context);
    } finally {
      await harness.close(context);
    }
  }, 60_000);
});
