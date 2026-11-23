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
  it("offers each research subagent the search tool, and its searches return corpus hits", async () => {
    const offered: string[][] = [];
    const childTurn: FauxResponseStep = (request) => {
      // pi-ai carries tool declarations in the transcript's system messages.
      const names = new Set<string>();
      for (const message of request.messages) {
        if (message.role !== "system") continue;
        for (const tool of message.toolsAdded ?? []) names.add(tool.name);
        for (const tool of message.toolsRemoved ?? []) names.delete(tool.name);
      }
      offered.push([...names]);
      const last = request.messages[request.messages.length - 1];
      return last?.role === "toolResult"
        ? fauxAssistantMessage([
            fauxText(`Answer from ${JSON.stringify(last.content).slice(0, 80)}`),
          ])
        : fauxAssistantMessage([fauxToolCall("search", { query: "kill switches" })], {
            stopReason: "toolUse",
          });
    };
    const { harness, root } = await openAgent([
      fauxAssistantMessage([fauxToolCall("research", { question: "How do kill switches work?" })], {
        stopReason: "toolUse",
      }),
      childTurn,
      childTurn,
      childTurn,
      childTurn,
      childTurn,
      childTurn,
      fauxAssistantMessage([fauxText("Synthesis.")]),
    ]);
    try {
      const submission = await root.submit(
        { type: "input", content: "Research how kill switches work" },
        context,
      );
      expect((await submission.wait(context)).status).toBe("done");
      expect(offered).toHaveLength(6);
      expect(offered.every((names) => names.includes("search"))).toBe(true);

      const searchResults = await harness.commit(async (tx) => {
        const children = (await tx.scanConversations({}, 100)).items.filter(
          (conversation) => conversation.owner !== undefined,
        );
        const results = [];
        for (const child of children) {
          const page = await tx.scanEntries({ conversationId: child.id }, 100);
          for (const entry of page.items)
            for (const message of entry.model ?? [])
              if (message.role === "toolResult" && message.toolName === "search")
                results.push(message);
        }
        return results;
      }, context);
      expect(searchResults).toHaveLength(3);
      expect(searchResults.every((result) => !result.isError)).toBe(true);
      expect(JSON.stringify(searchResults)).toContain("corpus:");
    } finally {
      await harness.close(context);
    }
  });

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
