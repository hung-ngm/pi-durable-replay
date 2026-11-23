import type { Context } from "@earendil-works/chord/context";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { int, obj, opt, str } from "@earendil-works/pi-schema";
import {
  AssistantEntry,
  configure,
  defineDoc,
  defineExtension,
  type ConversationId,
  type Extension,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { searchCorpus, type CorpusHit } from "./corpus.ts";

export const SEARCH_TOOL_NAME = "search";
export const RESEARCH_TOOL_NAME = "research";
export const CHARGE_CREDITS_TOOL_NAME = "charge_credits";
export const SLOW_SEARCH_TOOL_NAME = "slow_search";
export const LOOP_FOREVER_TOOL_NAME = "loop_forever";
export const CRASH_LOOP_TOOL_NAME = "crash_loop";

/** Execution attempts of the crash_loop fault tool, session-scoped (SPEC test 6 evidence). */
export const CrashDoc = defineDoc<{ attempts: number }>({
  kind: "app.crash",
  version: 1,
  scope: "session",
  initial: () => ({ attempts: 0 }),
  checkpointWhen: () => true,
});

export type LedgerEntry = {
  taskId: string;
  credits: number;
  memo: string;
  at: number;
};

/**
 * Every charge ever made in this Session, one entry per charge, keyed by the tool
 * task ID that made it (SPEC Q17). The ledger, not the transcript, is the
 * exactly-once proof: count entries with a task ID and the count is the answer.
 */
export const LedgerDoc = defineDoc<{ entries: LedgerEntry[] }>({
  kind: "app.ledger",
  version: 1,
  scope: "session",
  initial: () => ({ entries: [] }),
  // Store a small base whenever the ledger is empty, so replay stays short.
  checkpointWhen: (value) => value.entries.length === 0,
});

export interface ToolConfig {
  readonly searchBackend: string;
  readonly exaApiKey?: string;
  /**
   * How long charge_credits' simulated provider call takes. 300ms in production;
   * demos widen it so an interrupt or a kill -9 lands deterministically inside
   * the window between the ledger commit and the provider's answer.
   */
  readonly chargeDelayMs?: number;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function messageText(message: AssistantMessage | undefined): string {
  if (message === undefined) return "";
  if (typeof message.content === "string") return message.content;
  return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}

async function searchExa(query: string, apiKey: string, limit = 3): Promise<readonly CorpusHit[]> {
  const response = await fetch("https://api.exa.ai/search", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify({ query, numResults: limit, contents: { text: { maxCharacters: 400 } } }),
  });
  if (!response.ok) throw new Error(`Exa search failed (${response.status})`);
  const body = (await response.json()) as {
    results?: Array<{ url?: string; title?: string; text?: string }>;
  };
  return (body.results ?? []).map((result, index) => ({
    id: result.url ?? `exa:${index}`,
    title: result.title ?? "Untitled",
    snippet: (result.text ?? "").slice(0, 180),
    score: (body.results?.length ?? 0) - index,
  }));
}

export interface AgentTools {
  readonly searchTool: ToolRegistration;
  readonly researchTool: ToolRegistration;
  readonly chargeCreditsTool: ToolRegistration;
  readonly slowSearchTool: ToolRegistration;
  readonly loopForeverTool: ToolRegistration;
  readonly crashLoopTool: ToolRegistration;
  readonly all: readonly ToolRegistration[];
  /** Extension carrying only `search`, installed on research subagent conversations. */
  readonly searchExtension: Extension;
}

export function createTools(config: ToolConfig): AgentTools {
  const runSearch = async (query: string): Promise<readonly CorpusHit[]> => {
    if (config.searchBackend === "exa") {
      if (config.exaApiKey === undefined || config.exaApiKey === "") {
        throw new Error("SEARCH_BACKEND=exa requires the EXA_API_KEY secret");
      }
      return searchExa(query, config.exaApiKey);
    }
    return searchCorpus(query);
  };

  const searchTool: ToolRegistration = {
    name: SEARCH_TOOL_NAME,
    description:
      "Search the built-in corpus for evidence about durable agent execution. Deterministic: the same query always returns the same hits. Returns at most 3 hits with document IDs to cite.",
    parameters: obj({
      query: str({ description: "What to look for, as keywords or a short question" }),
    }),
    replay: "safe",
    execute: async (args) => {
      const { query } = args as { query: string };
      const hits = await runSearch(query);
      return {
        output: [{ type: "text" as const, text: JSON.stringify({ query, hits }) }],
        details: { query, hits: [...hits] },
      };
    },
  };

  const searchExtension = defineExtension({ name: "corpus-search", tools: [searchTool] });

  const ANGLES = [
    "the strongest evidence for",
    "the limitations and counterarguments to",
    "the costs and operational impact of",
  ] as const;

  const researchTool: ToolRegistration = {
    name: RESEARCH_TOOL_NAME,
    description:
      "Research a question with three parallel subagents: one gathers evidence for, one gathers limitations and counterarguments, one gathers costs and operational impact. Each subagent searches the corpus in its own conversation. Returns the three answers; synthesize them for the user.",
    parameters: obj({
      question: str({ description: "The research question" }),
    }),
    // Safe to rerun after a crash: children are owned by this task, so a rerun finds
    // the ones it already created, and each submission is keyed by this task's ID.
    replay: "safe",
    execute: async (args, api, context) => {
      const { question } = args as { question: string };
      const childIds: ConversationId[] = await api.commit(async (tx) => {
        const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 10)).items
          .map((conversation) => conversation.id)
          .sort((a, b) => a - b);
        const ids = [...existing];
        while (ids.length < ANGLES.length) {
          const child = await tx.createConversation({
            ownership: { kind: "task", taskId: api.taskId },
          });
          await configure(tx, child.id, {
            extensions: [searchExtension],
            tools: [searchTool],
          });
          ids.push(child.id);
        }
        return ids.slice(0, ANGLES.length);
      }, context);
      await api.details({ conversationIds: childIds }, context);

      const submissions = await Promise.all(
        childIds.map(async (childId, index) => {
          const child = await api.conversation(childId, context);
          if (child === undefined) throw new Error(`Research conversation ${childId} is missing`);
          return child.submit(
            {
              type: "input",
              content:
                `Research ${ANGLES[index]}: ${question}\n\n` +
                "Use the search tool with a few relevant queries. Reply briefly and cite corpus document IDs for every claim.",
              requestId: `research:${api.taskId}:${index}`,
            },
            context,
          );
        }),
      );
      const answers = await Promise.all(
        submissions.map(async (submission, index) => {
          const settled = await submission.wait(context);
          if (settled.status !== "done" || settled.type !== "input") {
            throw new Error(`Research subagent ${index} did not answer: ${settled.status}`);
          }
          const entry = await api.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
          return {
            angle: ANGLES[index],
            conversationId: childIds[index],
            answer: messageText(entry?.model?.[0] as AssistantMessage | undefined),
          };
        }),
      );
      return {
        output: [{ type: "text" as const, text: JSON.stringify({ question, answers }) }],
        details: { question, answers },
      };
    },
  };

  const chargeCreditsTool: ToolRegistration = {
    name: CHARGE_CREDITS_TOOL_NAME,
    description:
      "Charge fake credits for premium corpus access. UNSAFE: this moves (fake) money. The charge is recorded in the ledger keyed by this tool task's ID before the provider call, so an interrupted charge still lands exactly once.",
    parameters: obj({
      credits: int({ minimum: 1, maximum: 10_000, description: "Credits to charge" }),
      memo: str({ description: "What the charge is for" }),
    }),
    replay: "unsafe",
    execute: async (args, api, context) => {
      const { credits, memo } = args as { credits: number; memo: string };
      // Intent before effect: the ledger entry commits first, in the same commit the
      // task would checkpoint with. A crash after this commit cannot double-charge,
      // because a rerun finds its own entry; an unsafe tool is never silently rerun.
      const entry = await api.commit(async (tx) => {
        const ledger = await tx.doc(LedgerDoc);
        const existing = ledger.entries.find((e) => e.taskId === String(api.taskId));
        if (existing !== undefined) return existing;
        const created: LedgerEntry = {
          taskId: String(api.taskId),
          credits,
          memo,
          at: api.now(),
        };
        ledger.entries.push(created);
        return created;
      }, context);
      // The simulated provider call: deliberately after the durable intent.
      await sleep(config.chargeDelayMs ?? 300);
      return {
        output: [
          {
            type: "text" as const,
            text: `Charged ${entry.credits} credits for ${JSON.stringify(entry.memo)}. Ledger entry keyed by tool task ${entry.taskId}.`,
          },
        ],
        details: entry,
      };
    },
  };

  const slowSearchTool: ToolRegistration = {
    name: SLOW_SEARCH_TOOL_NAME,
    description:
      "A deliberately slow staged search (fault tool, for kill-switch demos): streams progress over several seconds, then returns corpus hits. Use when asked to demonstrate a long-running tool call.",
    parameters: obj({
      query: str({ description: "What to look for" }),
      seconds: opt(
        int({ minimum: 0, maximum: 120, description: "Total seconds to take (default 8)" }),
      ),
    }),
    replay: "safe",
    execute: async (args, api, context) => {
      const { query, seconds } = args as { query: string; seconds?: number };
      const totalMs = (seconds ?? 8) * 1000;
      const stages = 4;
      for (let stage = 1; stage <= stages; stage++) {
        api.output(`slow_search stage ${stage}/${stages} for ${JSON.stringify(query)}\n`);
        await api.details({ stage, stages, query }, context);
        if (stage < stages) await sleep(totalMs / stages);
      }
      const hits = await runSearch(query);
      return {
        output: [{ type: "text" as const, text: JSON.stringify({ query, hits }) }],
        details: { query, hits: [...hits] },
      };
    },
  };

  const loopForeverTool: ToolRegistration = {
    name: LOOP_FOREVER_TOOL_NAME,
    description:
      "FAULT TOOL: recruits subagent conversations that each call loop_forever again, growing without bound until a kill or a budget stops it. Only call when asked to demonstrate a runaway loop.",
    parameters: obj({
      topic: str({ description: "What the loop is nominally about" }),
    }),
    replay: "unsafe",
    execute: async (args, api, context) => {
      const { topic } = args as { topic: string };
      // Recruit one child per round, forever. Each child's generation calls this tool
      // again, so the tree grows until something aborts it. The round cap only exists
      // so a forgotten loop in a test cannot recruit literally forever.
      for (let round = 0; round < 100_000; round++) {
        await api.commit(async (tx) => {
          const child = await tx.createConversation({
            ownership: { kind: "task", taskId: api.taskId },
          });
          await configure(tx, child.id, {
            extensions: [loopExtension],
            tools: [loopForeverTool],
          });
          return child.id;
        }, context);
        const children = await api.commit(
          (tx) => tx.scanConversations({ ownerTaskId: api.taskId }, 100_000),
          context,
        );
        const childId = children.items[children.items.length - 1]!.id;
        const child = await api.conversation(childId, context);
        if (child !== undefined) {
          await child.submit(
            {
              type: "input",
              content: `Call the loop_forever tool with topic ${JSON.stringify(topic)}. Do not answer any other way.`,
              requestId: `loop:${api.taskId}:${round}`,
            },
            context,
          );
        }
        await api.details({ round, topic }, context);
        await sleep(200);
      }
      throw new Error("loop_forever reached its round cap");
    },
  };

  const loopExtension = defineExtension({ name: "loop", tools: [loopForeverTool] });

  const crashLoopTool: ToolRegistration = {
    name: CRASH_LOOP_TOOL_NAME,
    description:
      "FAULT TOOL: starts and then hangs for 30 seconds, so every process crash, eviction, or reset cuts it off mid-run; after the restart limit (5) it ends with a restart_limit report instead of running again. Only call when asked to demonstrate a crash loop.",
    parameters: obj({
      topic: str({ description: "What the crash loop is nominally about" }),
    }),
    replay: "safe",
    execute: async (args, api, context) => {
      const { topic } = args as { topic: string };
      const attempts = await api.commit(async (tx) => {
        const doc = await tx.doc(CrashDoc);
        doc.attempts += 1;
        return doc.attempts;
      }, context);
      api.output(`crash_loop attempt ${attempts} for ${JSON.stringify(topic)}: running\n`);
      await api.details({ attempt: attempts, topic }, context);
      await sleep(30_000);
      return {
        output: [{ type: "text" as const, text: `crash_loop finished attempt ${attempts}` }],
        details: { attempt: attempts },
      };
    },
  };

  return {
    searchTool,
    researchTool,
    chargeCreditsTool,
    slowSearchTool,
    loopForeverTool,
    crashLoopTool,
    all: [
      searchTool,
      researchTool,
      chargeCreditsTool,
      slowSearchTool,
      loopForeverTool,
      crashLoopTool,
    ],
    searchExtension,
  };
}
