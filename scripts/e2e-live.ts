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
 * makes the agent fan out three research subagents, and
 * assert the markers come back over the wire - subagent conversations, tool
 * calls, and a cited summary. Also
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

// Bun's WebSocket accepts headers; browsers use the sign-in cookie instead.
const ws = new WebSocket(`${wsBase}/api/sessions/${sessionId}`, {
  headers: { Authorization: `Bearer ${controlToken}` },
} as unknown as string[]);
const seen = {
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
    session?: { control?: { tokenBudget?: number } };
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
    if (control?.tokenBudget === 42_000) seen.budgetsEcho = true;
    if (!submitted) {
      submitted = true;
      console.log("submitting research prompt...");
      ws.send(
        JSON.stringify({
          type: "prompt.submit",
          requestId: "e2e-1",
          conversationId: 1,
          content:
            "Research how kill switches work in durable agents using the research tool, then give me a short summary with citations.",
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
    for (const name of ["research", "search"]) {
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
    seen.toolCalls.has("research") &&
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
    toolCalls: [...seen.toolCalls],
    subagents: seen.subagents.size,
    citedSummary: seen.summarySeen,
    budgetsEcho: seen.budgetsEcho,
    errors: seen.errors,
  }),
);
const pass =
  seen.toolCalls.has("research") &&
  seen.subagents.size >= 3 &&
  seen.summarySeen &&
  seen.budgetsEcho;
console.log(pass ? "E2E LIVE: PASS" : "E2E LIVE: FAIL");
ws.close();
process.exit(pass ? 0 : 1);
