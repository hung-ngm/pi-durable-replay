/**
 * Live end-to-end check against the real model (not part of the test suite).
 *
 * Start the Worker with the real key available to it, e.g. locally:
 *
 *   bun x wrangler dev --port 8799 --var OPENAI_API_KEY:... --var CONTROL_TOKEN:e2e-control-token
 *
 * or point it at a deployment, then run:
 *
 *   bun run scripts/e2e-live.ts
 *   E2E_BASE_URL=https://pi-durable-replay.<account>.workers.dev E2E_CONTROL_TOKEN=... bun run scripts/e2e-live.ts
 *
 * Drives the real WebSocket protocol: create a session, submit a prompt that
 * makes the agent fan out three research subagents and charge credits, and
 * assert the markers come back over the wire - subagent conversations, tool
 * calls, a Ledger entry in the session snapshot, and a cited summary. Also
 * round-trips a budgets change through the Control Panel's command.
 */

const baseUrl = process.env.E2E_BASE_URL ?? "http://127.0.0.1:8799";
const controlToken = process.env.E2E_CONTROL_TOKEN ?? "e2e-control-token";
const wsBase = baseUrl.replace(/^http/, "ws");

const created = await fetch(`${baseUrl}/api/sessions`, {
  method: "POST",
  headers: { Authorization: `Bearer ${controlToken}` },
});
if (created.status !== 201) {
  console.error(`session create failed: ${created.status} ${await created.text()}`);
  process.exit(1);
}
const { sessionId } = (await created.json()) as { sessionId: string };
console.log("session:", sessionId);

const unauthorized = await fetch(`${baseUrl}/api/sessions/${sessionId}`, {
  headers: { Upgrade: "websocket" },
});
console.log("socket without token ->", unauthorized.status, "(expect 401)");

const ws = new WebSocket(`${wsBase}/api/sessions/${sessionId}?token=${controlToken}`);
const seen = {
  ledger: 0,
  subagents: new Set<number>(),
  toolCalls: new Set<string>(),
  summarySeen: false,
  budgetsEcho: false,
  errors: [] as string[],
};
let submitted = false;
let budgetsSent = false;
const deadline = Date.now() + 240_000;

ws.addEventListener("message", (event) => {
  const raw = String(event.data);
  let frame: {
    type?: string;
    session?: { control?: { ledger?: unknown[]; tokenBudget?: number } };
    conversation?: { id?: number; owner?: unknown };
    ok?: boolean;
  };
  try {
    frame = JSON.parse(raw);
  } catch {
    return;
  }
  if (frame.type === "session.snapshot") {
    const control = frame.session?.control;
    const ledger = control?.ledger ?? [];
    if (ledger.length > seen.ledger) {
      seen.ledger = ledger.length;
      console.log("ledger:", JSON.stringify(ledger));
    }
    if (control?.tokenBudget === 42_000) seen.budgetsEcho = true;
    if (!submitted) {
      submitted = true;
      console.log("submitting research + charge prompt...");
      ws.send(
        JSON.stringify({
          type: "prompt.submit",
          requestId: "e2e-1",
          conversationId: 1,
          content:
            "Research how kill switches work in durable agents using the research tool, then charge 10 credits with memo 'e2e live test' using charge_credits, then give me a short summary with citations.",
        }),
      );
    } else if (!budgetsSent) {
      budgetsSent = true;
      ws.send(
        JSON.stringify({
          type: "control.setBudgets",
          requestId: "e2e-budgets",
          tokenBudget: 42_000,
          turnBudget: 12,
        }),
      );
    }
  }
  if (frame.type === "conversation.created" && frame.conversation?.owner !== undefined) {
    seen.subagents.add(frame.conversation.id as number);
    console.log("subagent conversation:", frame.conversation.id);
  }
  if (frame.type === "command.result" && frame.ok === false) {
    seen.errors.push(raw.slice(0, 200));
    console.log("command error:", raw.slice(0, 200));
  }
  if (raw.includes('"toolCall"')) {
    for (const name of ["research", "search", "charge_credits"]) {
      if (raw.includes(`"${name}"`) && !seen.toolCalls.has(name)) {
        seen.toolCalls.add(name);
        console.log("tool call:", name);
      }
    }
  }
  if (raw.includes("corpus:") && raw.includes("kill")) {
    if (!seen.summarySeen) console.log("cited summary text streaming in");
    seen.summarySeen = true;
  }
});

while (Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 1000));
  if (
    seen.ledger >= 1 &&
    seen.toolCalls.has("research") &&
    seen.toolCalls.has("charge_credits") &&
    seen.subagents.size >= 3 &&
    seen.summarySeen &&
    seen.budgetsEcho
  ) {
    break;
  }
}

console.log(
  "SUMMARY:",
  JSON.stringify({
    ledgerEntries: seen.ledger,
    toolCalls: [...seen.toolCalls],
    subagents: seen.subagents.size,
    citedSummary: seen.summarySeen,
    budgetsEcho: seen.budgetsEcho,
    errors: seen.errors,
  }),
);
const pass =
  seen.ledger >= 1 &&
  seen.toolCalls.has("research") &&
  seen.toolCalls.has("charge_credits") &&
  seen.subagents.size >= 3 &&
  seen.summarySeen &&
  seen.budgetsEcho;
console.log(pass ? "E2E LIVE: PASS" : "E2E LIVE: FAIL");
ws.close();
process.exit(pass ? 0 : 1);
