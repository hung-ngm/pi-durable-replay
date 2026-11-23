/**
 * Local kill -9 demo (SPEC acceptance test 7), driven by scripts/local-kill-demo.sh.
 *
 *   bun run scripts/local-kill-demo.ts child <db> <safe|unsafe>
 *     Opens the harness over a file-backed SQLite store, starts a run whose tool
 *     call is deliberately slow, prints markers as it goes, and then waits to be
 *     killed. The charge scenario widens the simulated provider window to 20s
 *     (ToolConfig.chargeDelayMs) so the kill lands after the ledger commit but
 *     before the provider answers.
 *
 *   bun run scripts/local-kill-demo.ts resume <db> <safe|unsafe>
 *     Reopens the same store in a fresh process, resumes, waits for the run to
 *     settle, prints the transcript and the Ledger, and asserts the SPEC claims:
 *     a safe tool reruns and completes; an unsafe tool is reported interrupted,
 *     is never re-fired, and the Ledger still holds exactly one entry.
 *
 * Needs OPENAI_API_KEY in the environment (the demo runs the real agent).
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, ROOT_CONVERSATION_ID, type TaskGraph } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createAgentHarnessOptions } from "../src/agent.ts";
import { LedgerDoc } from "../src/tools.ts";

const context = BACKGROUND_CONTEXT;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const [, , mode, dbPath, scenario] = process.argv;
if ((mode !== "child" && mode !== "resume") || dbPath === undefined || scenario === undefined) {
  console.error("usage: local-kill-demo.ts <child|resume> <db> <safe|unsafe>");
  process.exit(2);
}
const isSafe = scenario === "safe";
const requestId = isSafe ? "demo-safe-1" : "demo-unsafe-1";
const prompt = isSafe
  ? "Run slow_search for 'durable execution' with seconds 12 now. Call the tool, wait for it, then summarize the hits in one sentence."
  : "Charge 25 credits with memo 'local kill demo' using charge_credits now. Call the tool, wait for it, then confirm the charge in one sentence.";

const storage = await openNodeSqliteStorage(dbPath);
const harness = await Harness.open(
  storage,
  createAgentHarnessOptions({ searchBackend: "corpus", chargeDelayMs: 20_000 }),
  context,
);
const root = await harness.root(context);

const ledgerCount = async (): Promise<number> =>
  (await harness.snapshot(LedgerDoc, context))?.entries.length ?? 0;

if (mode === "child") {
  const watch = await harness.watchTaskGraph(context);
  watch.start(async () => {});
  const submission = await root.submit({ type: "input", content: prompt, requestId }, context);
  console.log(`[child:${scenario}] submitted run (submission ${submission.id})`);
  console.log(`[child:${scenario}] prompt: ${prompt}`);
  // Wait until the tool call is actually running, say so, then wait to be killed.
  for (;;) {
    const graph: TaskGraph = watch.value;
    const tool = Object.values(graph.tasks).find((node) => node.kind === "pi.tool");
    if (tool !== undefined) {
      console.log(`[child:${scenario}] TOOL RUNNING (task ${tool.id})`);
      if (!isSafe) {
        while ((await ledgerCount()) === 0) await sleep(25);
        console.log(`[child:${scenario}] LEDGER COMMITTED (1 entry) - provider still answering`);
      }
      break;
    }
    await sleep(50);
  }
  console.log(`[child:${scenario}] waiting - the parent will now kill -9 this process`);
  await sleep(600_000);
} else {
  console.log(`[resume:${scenario}] reopened the store in a fresh process; resuming`);
  harness.resume();
  // Wait for the original submission to settle.
  let status: string | undefined;
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const record = await storage.submissionByRequest(ROOT_CONVERSATION_ID, requestId, context);
    if (record !== undefined && record.status !== "placed") {
      status = record.status;
      break;
    }
    await sleep(250);
  }
  if (status === undefined) {
    console.error(`[resume:${scenario}] FAIL: the run never settled`);
    process.exit(1);
  }
  console.log(`[resume:${scenario}] run settled: ${status}`);

  const entries = await harness.commit(
    (tx) => tx.scanEntries({ conversationId: root.id }, 100),
    context,
  );
  console.log(`[resume:${scenario}] transcript (oldest first):`);
  for (const entry of [...entries.items].reverse()) {
    for (const message of entry.model ?? []) {
      if (message.role === "user") {
        console.log(`  user: ${message.content}`);
      } else if (message.role === "assistant") {
        for (const block of message.content) {
          if (block.type === "text" && block.text.trim() !== "") {
            console.log(`  assistant: ${block.text.trim()}`);
          } else if (block.type === "toolCall") {
            console.log(
              `  assistant -> tool call: ${block.name} ${JSON.stringify(block.arguments)}`,
            );
          }
        }
      } else if (message.role === "toolResult") {
        const text = message.content
          .map((block) => (block.type === "text" ? block.text : ""))
          .join(" ")
          .slice(0, 220);
        console.log(
          `  tool result (${message.toolName})${message.isError ? " [error]" : ""}: ${text}`,
        );
      }
    }
  }

  const ledger = (await harness.snapshot(LedgerDoc, context))?.entries ?? [];
  console.log(`[resume:${scenario}] ledger: ${JSON.stringify(ledger)}`);

  const toolResults = entries.items.flatMap((entry) =>
    (entry.model ?? []).filter((message) => message.role === "toolResult"),
  );
  let ok = true;
  if (isSafe) {
    const completed = toolResults.some(
      (result) => result.toolName === "slow_search" && !result.isError,
    );
    console.log(`[resume:safe] safe tool reran and completed after the kill: ${completed}`);
    ok = completed;
  } else {
    const interrupted = toolResults.some(
      (result) => result.toolName === "charge_credits" && result.isError,
    );
    console.log(`[resume:unsafe] interrupted charge reported, never re-fired: ${interrupted}`);
    console.log(`[resume:unsafe] exactly one ledger entry: ${ledger.length === 1}`);
    ok = interrupted && ledger.length === 1;
  }
  console.log(`[resume:${scenario}] ${ok ? "PASS" : "FAIL"}`);
  await harness.close(context);
  process.exit(ok ? 0 : 1);
}
