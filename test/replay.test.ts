import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type FauxResponseStep,
} from "@earendil-works/pi-ai";
import { Harness, MemoryStorage, type TaskGraph } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { createAgentHarnessOptions } from "../src/agent.ts";
import { readReplay, replayFork } from "../src/replay.ts";

const context = BACKGROUND_CONTEXT;

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
});
