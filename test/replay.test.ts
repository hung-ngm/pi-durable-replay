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
  Harness,
  MemoryStorage,
  ToolResultEntry,
  type TaskGraph,
} from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { createAgentHarnessOptions } from "../src/agent.ts";
import { kill } from "../src/control.ts";
import { approveUnsafe, readReplay, replayFork } from "../src/replay.ts";
import { LedgerDoc } from "../src/tools.ts";

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
  return { harness, root, graph: () => watch.value as TaskGraph };
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

const readLedger = async (harness: Harness) =>
  (await harness.snapshot(LedgerDoc, context))?.entries ?? [];

describe("replay (SPEC tests 3 and 4)", () => {
  it("test 3: interrupt during a charge, a model retry, then Resume, leaves exactly one ledger entry", async () => {
    const { harness, root, graph } = await openAgent([
      fauxAssistantMessage(
        [fauxToolCall("charge_credits", { credits: 25, memo: "premium depth" })],
        {
          stopReason: "toolUse",
        },
      ),
      // After the abort the model only sees "interrupted and may have partially run",
      // so it retries the same charge. The ledger already holds it.
      fauxAssistantMessage(
        [fauxToolCall("charge_credits", { credits: 25, memo: "premium depth" })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage([fauxText("The charge had already landed; wrapping up.")]),
      // The Resume prompt's response.
      fauxAssistantMessage([fauxText("Resumed without charging again.")]),
    ]);
    try {
      const submission = await root.submit(
        { type: "input", content: "Charge 25 credits for the report." },
        context,
      );
      // The ledger entry commits before the simulated provider call (a 300ms
      // window); interrupt the tool task inside that window.
      const ledgerDeadline = Date.now() + 15_000;
      while ((await readLedger(harness)).length !== 1) {
        if (Date.now() > ledgerDeadline) throw new Error("ledger entry never appeared");
        await sleep(5);
      }
      const toolNode = await poll(() =>
        Object.values(graph().tasks).find(
          (node) => node.kind === "pi.tool" && node.state.status === "running",
        ),
      );
      await kill(
        harness,
        graph(),
        { scope: "tool", conversationId: root.id, taskId: toolNode.id, reason: "manual" },
        context,
      );
      // Aborting the tool does not fail the run: the model sees the interrupted
      // result and wraps up. The claim under test is the ledger, below.
      await submission.wait(context);

      // Resume: a new prompt in the same conversation. The interrupted unsafe
      // tool is never re-fired, so the ledger still holds exactly one entry.
      const resumed = await root.submit({ type: "input", content: "Continue." }, context);
      expect((await resumed.wait(context)).status).toBe("done");
      const entries = await readLedger(harness);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ taskId: String(toolNode.id), credits: 25 });

      // The retry reported the existing charge instead of making a second one.
      const retryResult = await harness.commit(async (tx) => {
        const page = await tx.scanEntries({ conversationId: root.id }, 100);
        return page.items
          .flatMap((entry) => entry.model ?? [])
          .find(
            (message) =>
              message.role === "toolResult" &&
              message.toolName === "charge_credits" &&
              JSON.stringify(message.content).includes("Already charged"),
          );
      }, context);
      expect(retryResult).toBeDefined();
    } finally {
      await harness.close(context);
    }
  }, 60_000);

  it("test 4: Fork Replay carries safe results forward and gates the unsafe tool until approved", async () => {
    const { harness, root } = await openAgent([
      // Run 1: two safe searches and one charge complete, then the provider fails.
      fauxAssistantMessage(
        [
          fauxToolCall("search", { query: "durable execution" }),
          fauxToolCall("search", { query: "exactly once" }),
          fauxToolCall("charge_credits", { credits: 10, memo: "premium depth" }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("provider exploded", {
        stopReason: "error",
        errorMessage: "provider exploded",
      }),
      // Fork run 1: the model tries to charge again - the gate must block it.
      fauxAssistantMessage(
        [fauxToolCall("charge_credits", { credits: 10, memo: "premium depth" })],
        {
          stopReason: "toolUse",
        },
      ),
      fauxAssistantMessage([fauxText("Blocked, waiting for approval.")]),
      // Fork run 2 (after approval): the charge goes through.
      fauxAssistantMessage(
        [fauxToolCall("charge_credits", { credits: 10, memo: "premium depth" })],
        {
          stopReason: "toolUse",
        },
      ),
      fauxAssistantMessage([fauxText("Charged after approval.")]),
    ]);
    try {
      const first = await root.submit(
        { type: "input", content: "Research and charge 10 credits." },
        context,
      );
      await first.wait(context);
      expect(await readLedger(harness)).toHaveLength(1);

      // Fork at the newest committed entry: everything the failed run committed.
      const { forkEntryId, sawToolResult } = await harness.commit(async (tx) => {
        const page = await tx.scanEntries({ conversationId: root.id }, 100);
        return {
          forkEntryId: page.items[0]?.id ?? 0,
          sawToolResult: page.items.some((entry) => ToolResultEntry.is(entry)),
        };
      }, context);
      expect(sawToolResult).toBe(true);

      const fork = await replayFork(harness, root.id, forkEntryId, context);
      expect(fork.carried.map((entry) => entry.name).sort()).toEqual([
        "charge_credits",
        "search",
        "search",
      ]);
      expect(fork.pendingUnsafeApproval).toBe(true);
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

      // The two searches did not run again in the fork, and the charge was
      // blocked: only the generation and the one blocked tool task exist there,
      // and the ledger still holds exactly the one carried charge.
      const forkTasks = await harness.commit(async (tx) => {
        const page = await tx.scanTasks({}, 200);
        return page.items.filter(
          (task) => (task.conversationId as number) === (fork.conversationId as number),
        );
      }, context);
      // Exactly one tool task ran in the fork: the blocked charge. The two
      // searches were carried as history and never re-fired.
      expect(forkTasks.filter((task) => task.kind === "pi.tool")).toHaveLength(1);
      expect(await readLedger(harness)).toHaveLength(1);

      // Approve, then the same call goes through exactly once more.
      await approveUnsafe(harness, fork.conversationId, context);
      expect((await readReplay(harness, fork.conversationId, context))?.pendingUnsafeApproval).toBe(
        false,
      );
      const approvedRun = await forkConversation.submit(
        { type: "input", content: "Charge now." },
        context,
      );
      expect((await approvedRun.wait(context)).status).toBe("done");
      expect(await readLedger(harness)).toHaveLength(2);
    } finally {
      await harness.close(context);
    }
  }, 60_000);

  it("Fork Replay before a landed charge's result still gates the charge", async () => {
    const { harness, root } = await openAgent([
      fauxAssistantMessage(
        [fauxToolCall("charge_credits", { credits: 10, memo: "premium depth" })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage([fauxText("Charged.")]),
      // The fork redoes the part after the tool call, and the model charges again.
      fauxAssistantMessage(
        [fauxToolCall("charge_credits", { credits: 10, memo: "premium depth" })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage([fauxText("Blocked, waiting for approval.")]),
    ]);
    try {
      const run = await root.submit({ type: "input", content: "Charge 10 credits." }, context);
      await run.wait(context);
      expect(await readLedger(harness)).toHaveLength(1);

      // Fork at the assistant entry that made the call: the charge's result is not
      // in the carried history, but the charge already happened.
      const callEntryId = await harness.commit(async (tx) => {
        const page = await tx.scanEntries({ conversationId: root.id }, 100);
        return page.items.find((entry) =>
          (entry.model ?? []).some(
            (message) =>
              message.role === "assistant" &&
              message.content.some(
                (block) => block.type === "toolCall" && block.name === "charge_credits",
              ),
          ),
        )?.id;
      }, context);
      if (callEntryId === undefined) throw new Error("charge call entry missing");

      const fork = await replayFork(harness, root.id, callEntryId, context);
      expect(fork.carried.map((entry) => entry.name)).not.toContain("charge_credits");
      expect(fork.pendingUnsafeApproval).toBe(true);

      const forkConversation = await harness.conversation(fork.conversationId, context);
      if (forkConversation === undefined) throw new Error("fork conversation missing");
      await forkConversation.configure({ model: { provider: "faux", modelId: "faux-1" } }, context);
      const forkRun = await forkConversation.submit({ type: "input", content: "Finish." }, context);
      await forkRun.wait(context);
      expect(await readLedger(harness)).toHaveLength(1);
    } finally {
      await harness.close(context);
    }
  }, 60_000);
});
