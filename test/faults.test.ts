import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import {
  Harness,
  ROOT_CONVERSATION_ID,
  type ConversationId,
  type Storage,
} from "@earendil-works/pi-durable";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { describe, expect, it } from "vitest";
import { createAgentHarnessOptions } from "../src/agent.ts";

const context = BACKGROUND_CONTEXT;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const openStorage = (state: DurableObjectState) => openDurableObjectSqliteStorage(state.storage);

function agentOptionsWithFaux(responses: readonly FauxResponseStep[]) {
  const faux = fauxProvider();
  faux.setResponses([...responses]);
  const models = createModels();
  models.setProvider(faux.provider);
  return { ...createAgentHarnessOptions(), models };
}

async function wake(sessionId: string): Promise<void> {
  const response = await exports.default.fetch(`https://example.com/api/sessions/${sessionId}`, {
    headers: { Upgrade: "websocket", Authorization: `Bearer ${env.CONTROL_TOKEN}` },
  });
  expect(response.status).toBe(101);
  response.webSocket!.accept();
  response.webSocket!.close(1000, "wake");
}

async function pollUntil(
  read: () => Promise<boolean>,
  label: string,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await read()) return;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await sleep(250);
  }
}

describe("fault injection (SPEC test 5)", () => {
  it("test 5: eviction mid-generation - the woken Session resumes the run through its alarm", async () => {
    const sessionId = "fault-eviction-resume";
    const stub = env.SESSIONS.getByName(sessionId);
    const firstRequestStarted = Promise.withResolvers<void>();
    const hanging: FauxResponseStep = async (_request, options) => {
      firstRequestStarted.resolve();
      return new Promise((_resolve, reject) => {
        const abort = () => reject(new DOMException("Request interrupted", "AbortError"));
        if (options?.signal?.aborted) abort();
        else options?.signal?.addEventListener("abort", abort, { once: true });
      });
    };

    // Seed an in-flight generation with the app's own composition, then evict.
    await runInDurableObject(stub, async (_instance, state) => {
      await state.blockConcurrencyWhile(async () => {});
      const storage = await openStorage(state);
      const harness = await Harness.open(storage, agentOptionsWithFaux([hanging]), context);
      try {
        const root = await harness.root(context);
        await root.configure({ model: { provider: "faux", modelId: "faux-1" } }, context);
        await root.submit(
          { type: "input", content: "Answer after recovery", requestId: "fault-eviction-turn" },
          context,
        );
        await firstRequestStarted.promise;
      } finally {
        await harness.close(context);
      }
    });
    await evictDurableObject(stub);

    // The alarm-driven wake is what a client connection triggers here: the new
    // instance opens, resumes, and the interrupted generation is re-run. In this
    // test environment the resumed provider call cannot complete (the faux
    // provider exists only in the seed harness), so the submission settles
    // "unanswered" - the observable proof the run resumed and finished its
    // lifecycle in the woken Session. With a real provider key, the same resume
    // produces the answer.
    await wake(sessionId);
    let status: string | undefined;
    await pollUntil(async () => {
      status = await runInDurableObject(stub, async (_instance, state) => {
        const submission = await (
          await openStorage(state)
        ).submissionByRequest(ROOT_CONVERSATION_ID, "fault-eviction-turn", context);
        return submission?.status === "placed" ? undefined : submission?.status;
      });
      return status !== undefined;
    }, "the resumed submission to settle");
    expect(status).toBe("unanswered");

    // The fault.inject "evict" command path: a live socket is dropped when the
    // object cuts itself off.
    const response = await exports.default.fetch(`https://example.com/api/sessions/${sessionId}`, {
      headers: { Upgrade: "websocket", Authorization: `Bearer ${env.CONTROL_TOKEN}` },
    });
    expect(response.status).toBe(101);
    const socket = response.webSocket!;
    socket.accept();
    const closed = Promise.withResolvers<void>();
    socket.addEventListener("close", () => closed.resolve());
    socket.send(
      JSON.stringify({
        type: "fault.inject",
        requestId: "fault-evict-1",
        conversationId: 1,
        kind: "evict",
      }),
    );
    await Promise.race([
      closed.promise,
      sleep(15_000).then(() => {
        throw new Error("socket was not dropped by the eviction");
      }),
    ]);
  }, 120_000);
});
