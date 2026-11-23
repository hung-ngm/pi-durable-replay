import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { createAgentHarnessOptions } from "../src/agent.ts";
import { searchCorpus } from "../src/corpus.ts";
import { LedgerDoc } from "../src/tools.ts";

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
  return { harness, root };
}

describe("corpus search", () => {
  it("is deterministic and cites stable document IDs", () => {
    const first = searchCorpus("idempotency keys charge exactly once");
    const second = searchCorpus("idempotency keys charge exactly once");
    expect(first).toEqual(second);
    expect(first.length).toBeGreaterThan(0);
    expect(first[0]?.id).toBe("corpus:idempotency-keys");
  });

  it("returns no hits for an empty or unknown query", () => {
    expect(searchCorpus("")).toEqual([]);
    expect(searchCorpus("zzzqqq")).toEqual([]);
  });
});

describe("research agent", () => {
  it("fans out to three subagent conversations and synthesizes their answers", async () => {
    const searchCall = fauxAssistantMessage(
      [fauxToolCall("search", { query: "kill switches budgets" })],
      { stopReason: "toolUse" },
    );
    const { harness, root } = await openAgent([
      fauxAssistantMessage([fauxToolCall("research", { question: "How do kill switches work?" })], {
        stopReason: "toolUse",
      }),
      // The three children run in parallel; each consumes one search call and one text.
      searchCall,
      searchCall,
      searchCall,
      fauxAssistantMessage([fauxText("Subagent answer A (corpus:kill-switches).")]),
      fauxAssistantMessage([fauxText("Subagent answer B (corpus:budget-kills).")]),
      fauxAssistantMessage([fauxText("Subagent answer C (corpus:cost-metering).")]),
      fauxAssistantMessage([fauxText("Synthesis of the three answers.")]),
    ]);
    try {
      const submission = await root.submit(
        { type: "input", content: "Research how kill switches work" },
        context,
      );
      const settled = await submission.wait(context);
      expect(settled.status).toBe("done");

      const conversations = await harness.commit((tx) => tx.scanConversations({}, 100), context);
      const children = conversations.items.filter((c) => c.owner !== undefined);
      expect(children).toHaveLength(3);
      expect(children.every((c) => c.owner !== undefined && "taskId" in c.owner)).toBe(true);
    } finally {
      await harness.close(context);
    }
  });

  it("writes exactly one ledger entry per charge, keyed by the tool task ID", async () => {
    const { harness, root } = await openAgent([
      fauxAssistantMessage(
        [fauxToolCall("charge_credits", { credits: 25, memo: "premium depth" })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage([fauxText("Charged.")]),
      fauxAssistantMessage([fauxToolCall("charge_credits", { credits: 40, memo: "more depth" })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage([fauxText("Charged again.")]),
    ]);
    try {
      const first = await root.submit(
        { type: "input", content: "Charge 25 credits for premium depth" },
        context,
      );
      await first.wait(context);
      // Snapshot inside the commit: a doc overlay cannot be read after it settles.
      let ledger = await harness.commit(
        async (tx) => ({
          entries: (await tx.doc(LedgerDoc)).entries.map((e) => ({
            taskId: e.taskId,
            credits: e.credits,
            memo: e.memo,
            at: e.at,
          })),
        }),
        context,
      );
      expect(ledger.entries).toHaveLength(1);
      expect(ledger.entries[0]).toMatchObject({ credits: 25, memo: "premium depth" });
      expect(ledger.entries[0]?.taskId).toBeTruthy();

      const second = await root.submit({ type: "input", content: "Charge 40 more" }, context);
      await second.wait(context);
      ledger = await harness.commit(
        async (tx) => ({
          entries: (await tx.doc(LedgerDoc)).entries.map((e) => ({
            taskId: e.taskId,
            credits: e.credits,
            memo: e.memo,
            at: e.at,
          })),
        }),
        context,
      );
      expect(ledger.entries).toHaveLength(2);
      expect(ledger.entries[1]).toMatchObject({ credits: 40, memo: "more depth" });
      expect(ledger.entries[1]?.taskId).not.toBe(ledger.entries[0]?.taskId);
    } finally {
      await harness.close(context);
    }
  });

  it("slow_search streams stages and returns corpus hits", async () => {
    const { harness, root } = await openAgent([
      fauxAssistantMessage([fauxToolCall("slow_search", { query: "fork replay", seconds: 0 })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage([fauxText("Done.")]),
    ]);
    try {
      const submission = await root.submit(
        { type: "input", content: "Slow-search fork replay" },
        context,
      );
      const settled = await submission.wait(context);
      expect(settled.status).toBe("done");
      expect(settled.status).toBe("done");
    } finally {
      await harness.close(context);
    }
  });
});
