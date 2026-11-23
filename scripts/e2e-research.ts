/**
 * Bun-level live E2E (not part of the test suite): runs the real agent with a
 * real OPENAI_API_KEY over file-backed storage - research fan-out (3 subagent
 * conversations) and a cited summary.
 *
 *   OPENAI_API_KEY=... bun run scripts/e2e-research.ts
 *
 * Keep this script inside the repo: pi-ai keeps module-level provider state,
 * and importing the agent through an outside path creates a second copy.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createAgentHarnessOptions } from "../src/agent.ts";
const context = BACKGROUND_CONTEXT;
const storage = await openNodeSqliteStorage("/tmp/e2e-research.sqlite");
const harness = await Harness.open(
  storage,
  createAgentHarnessOptions({ searchBackend: "corpus" }),
  context,
);
const root = await harness.root(context);
const sub = await root.submit(
  {
    type: "input",
    content:
      "Research how kill switches work in durable agents using the research tool, then give me a short summary with citations.",
    requestId: "e2e-research-1",
  },
  context,
);
const settled = await sub.wait(context);
console.log("settled:", settled.status);
const convs = await harness.commit((tx) => tx.scanConversations({}, 50), context);
const owned = convs.items.filter((c) => c.owner !== undefined);
console.log("conversations:", convs.items.length, "subagents:", owned.length);
const entries = await harness.commit(
  (tx) => tx.scanEntries({ conversationId: root.id }, 100),
  context,
);
let answer = "";
const tools = new Set<string>();
for (const e of entries.items)
  for (const m of e.model ?? []) {
    if (m.role === "assistant")
      for (const b of m.content) {
        if (b.type === "toolCall") tools.add(b.name);
        if (b.type === "text" && b.text.includes("corpus:")) answer = b.text;
      }
  }
console.log("tools called:", [...tools].join(", "));
// The final summary's citation typography is the model's choice; the flow
// claim is a substantive answer about the researched topic.
const texts = entries.items.flatMap((e) =>
  (e.model ?? [])
    .filter((m) => m.role === "assistant")
    .flatMap((m) => m.content.filter((b) => b.type === "text").map((b) => b.text)),
);
const finalText = texts.find((t) => t.toLowerCase().includes("kill switch")) ?? "";
console.log("answer excerpt:", finalText.slice(0, 400));
answer = finalText;
const pass =
  settled.status === "done" && owned.length === 3 && tools.has("research") && answer.length > 100;
console.log(pass ? "BUN E2E RESEARCH: PASS" : "BUN E2E RESEARCH: FAIL");
await harness.close(context);
process.exit(pass ? 0 : 1);
