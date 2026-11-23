import { applyImmutable } from "@earendil-works/chord/delta";
import { ConversationTranscript, type ConversationView } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import {
  initialSessionState,
  sessionReducer,
  type SessionState,
} from "../src/client/session-state.ts";
import { parseServerEventEnvelope } from "../src/protocol.ts";

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const assistant = (text: string) => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "faux",
  provider: "faux",
  model: "faux",
  usage,
  stopReason: "stop",
  timestamp: 2,
});

const event = (value: unknown) => parseServerEventEnvelope(JSON.stringify(value));

const user = (id: number, content: string) => ({
  id,
  conversationId: 1,
  kind: "pi.user",
  model: [{ role: "user", content, timestamp: 1 }],
});

const viewOf = (
  entries: readonly object[],
  docs: Record<string, object> = {},
  before?: number,
): ConversationView =>
  ({
    conversation: { id: 1 },
    entries,
    docs,
    ...(before === undefined ? {} : { before }),
  }) as unknown as ConversationView;

/** A client transcript that never pages: the tests below only merge views. */
const transcript = () => new ConversationTranscript(async () => ({ items: [] }));

/** Merges `view` into `client` and shows it, as the session hook does. */
const show = (
  state: SessionState,
  view: ConversationView,
  client: ConversationTranscript = transcript(),
): SessionState =>
  sessionReducer(state, { type: "view", conversationId: 1, view: client.merge(view) });

describe("session state", () => {
  it("renders a late join and the streamed answer from view operations", () => {
    const frame = event({
      type: "conversation.view",
      conversationId: 1,
      view: viewOf([user(2, "Hello")], {
        "pi.live": {
          run: { taskId: 5, inputs: [3], turns: 0 },
          generation: { attempt: 1, message: assistant("Hel") },
        },
        "pi.agent": { thinkingLevel: "off", tools: [] },
        "pi.usage": { models: {}, tools: {} },
      }),
    });
    if (frame.type !== "conversation.view") throw new Error("Expected a view frame");
    const client = transcript();
    let view = frame.view;
    let state = show(initialSessionState, view, client);
    expect(state.snapshots[1]).toMatchObject({
      isRunning: true,
      messages: [
        { role: "user", content: [{ type: "text", text: "Hello" }] },
        {
          role: "assistant",
          status: { type: "running" },
          content: [{ type: "text", text: "Hel" }],
        },
      ],
      agent: { thinkingLevel: "off", tools: [] },
      usage: { models: {}, tools: {} },
    });

    const apply = (ops: unknown[]) => {
      const update = event({ type: "conversation.ops", conversationId: 1, ops });
      if (update.type !== "conversation.ops") throw new Error("Expected an operations frame");
      view = applyImmutable(view, update.ops);
      state = show(state, view, client);
    };

    apply([["a", ["docs", "pi.live", "generation", "message", "content", 0, "text"], "lo"]]);
    expect(state.snapshots[1]?.messages.at(-1)?.content).toEqual([{ type: "text", text: "Hello" }]);

    apply([
      [
        "p",
        ["entries"],
        1,
        0,
        [{ id: 4, conversationId: 1, kind: "pi.assistant", model: [assistant("Hello")] }],
      ],
      ["d", ["docs", "pi.live", "generation"]],
      ["d", ["docs", "pi.live", "run"]],
    ]);
    expect(state.snapshots[1]).toMatchObject({
      isRunning: false,
      messages: [
        { role: "user", content: [{ type: "text", text: "Hello" }] },
        {
          role: "assistant",
          status: { type: "complete" },
          content: [{ type: "text", text: "Hello" }],
        },
      ],
    });
    expect(state.snapshots[1]?.messages).toHaveLength(2);
  });

  it("rejects malformed view operations", () => {
    expect(() =>
      event({ type: "conversation.ops", conversationId: 1, ops: [["s", [], 1]] }),
    ).toThrow();
    expect(() => event({ type: "conversation.view", conversationId: 1, view: {} })).toThrow(
      "Conversation view payload is invalid",
    );
  });

  it("labels compaction and reset entries in place and strips the summary wrapper", () => {
    const state = show(
      initialSessionState,
      viewOf([
        user(2, "Before the summary"),
        {
          id: 5,
          conversationId: 1,
          kind: "pi.compaction",
          head: 3,
          model: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: "The conversation history before this point was compacted into the following summary:\n\n<summary>\nUser asked about weather.\n</summary>",
                },
              ],
              timestamp: 1,
            },
          ],
          data: { reason: "threshold" },
        },
        { id: 6, conversationId: 1, kind: "pi.reset", head: 6 },
        {
          id: 7,
          conversationId: 1,
          kind: "pi.reset",
          head: 7,
          model: [{ role: "user", content: "Continue from the handoff.", timestamp: 2 }],
        },
      ]),
    );
    // The view keeps the history; head markers sit where they were written.
    expect(state.snapshots[1]?.messages.map(({ content }) => content[0])).toEqual([
      { type: "text", text: "Before the summary" },
      { type: "data-pi-context", data: { kind: "compaction", text: "User asked about weather." } },
      { type: "data-pi-context", data: { kind: "reset", text: "Context reset" } },
      { type: "data-pi-context", data: { kind: "reset", text: "Continue from the handoff." } },
    ]);
  });

  it("shows tool progress, compactions, the agent, and usage from the view's documents", () => {
    const state = show(
      initialSessionState,
      viewOf([], {
        "pi.live": {
          run: { taskId: 5, inputs: [3], turns: 1 },
          tools: [
            {
              callId: "call-1",
              name: "search",
              status: "running",
              taskId: 8,
              output: "searching",
              details: { matches: 2 },
              diagnostics: [{ severity: "info", message: "Using cached index" }],
            },
          ],
          compactions: [{ taskId: 9, trigger: "threshold", blocking: true, attempt: 1 }],
        },
        "pi.agent": {
          model: { provider: "openai", modelId: "gpt-test" },
          thinkingLevel: "high",
          tools: ["search"],
        },
        "pi.usage": {
          models: {
            "openai/gpt-test": { ...usage, input: 10, output: 5, totalTokens: 15 },
          },
          tools: {},
        },
      }),
    );
    expect(state.snapshots[1]).toMatchObject({
      isRunning: true,
      runTaskId: 5,
      messages: [
        {
          id: "tool:call-1",
          status: { type: "running" },
          content: [
            {
              type: "tool-call",
              toolCallId: "call-1",
              toolName: "search",
              result: "searching",
              isPreliminary: true,
              artifact: {
                details: { matches: 2 },
                diagnostics: [{ severity: "info", message: "Using cached index" }],
              },
            },
          ],
        },
      ],
      compactions: [{ taskId: 9, reason: "threshold", blocking: true }],
      agent: {
        model: { provider: "openai", modelId: "gpt-test" },
        thinkingLevel: "high",
        tools: ["search"],
      },
      usage: { models: { "openai/gpt-test": { input: 10, output: 5, totalTokens: 15 } } },
    });
  });

  it("explains a run or compaction that ended without a result", () => {
    let state = show(
      initialSessionState,
      viewOf([], {
        "pi.live": {
          runFailure: { taskId: 9, inputs: [3], reason: "model_error", detail: "401 Unauthorized" },
          compactionFailure: { taskId: 10, trigger: "manual", error: "summary failed" },
        },
      }),
    );
    expect(state.snapshots[1]?.messages).toMatchObject([
      {
        id: "failure:9",
        status: {
          type: "incomplete",
          reason: "error",
          error: "The model request failed: 401 Unauthorized",
        },
      },
    ]);

    state = show(
      state,
      viewOf([], {
        "pi.live": {
          compactionFailure: { taskId: 10, trigger: "manual", error: "summary failed" },
        },
      }),
    );
    expect(state.snapshots[1]?.messages).toMatchObject([
      {
        id: "failure:10",
        status: { type: "incomplete", reason: "error", error: "Compaction failed: summary failed" },
      },
    ]);

    state = show(state, viewOf([], { "pi.live": { run: { taskId: 11, inputs: [12], turns: 0 } } }));
    expect(state.snapshots[1]?.messages).toEqual([]);
  });

  it("lists queued inputs from the inbox document, without passive writes", () => {
    const state = show(
      initialSessionState,
      viewOf([], {
        "pi.inbox": {
          items: [
            { id: 5, mode: "followUp", content: "Next question" },
            {
              id: 6,
              mode: "steer",
              content: [{ type: "text", text: "Faster" }, { type: "image" }],
            },
            { id: 7, mode: "write", content: "context only" },
          ],
        },
      }),
    );
    expect(state.snapshots[1]?.queued).toEqual([
      { submissionId: 5, mode: "followUp", text: "Next question" },
      { submissionId: 6, mode: "steer", text: "Faster\n[Image]" },
    ]);
  });

  it("keeps typing presence when the view changes", () => {
    let state = sessionReducer(initialSessionState, {
      type: "event",
      event: event({ type: "presence.typing", conversationId: 1, usernames: ["Bob"] }),
    });
    state = show(state, viewOf([user(2, "Hi")]));
    expect(state.snapshots[1]?.typing).toEqual(["Bob"]);
  });

  it("does not change the selected conversation for prompt acknowledgements", () => {
    let state = sessionReducer(initialSessionState, { type: "select", conversationId: 2 });
    state = sessionReducer(state, {
      type: "event",
      event: event({
        type: "command.result",
        command: "prompt.submit",
        requestId: "prompt-1",
        ok: true,
        conversationId: 1,
        submissionId: 3,
      }),
    });
    expect(state.activeConversationId).toBe(2);

    state = sessionReducer(state, {
      type: "event",
      event: event({
        type: "command.result",
        command: "conversation.create",
        requestId: "create-1",
        ok: true,
        conversationId: 4,
      }),
    });
    expect(state.activeConversationId).toBe(4);
  });

  it("tracks the session activity graph from snapshots and updates", () => {
    let state = sessionReducer(initialSessionState, {
      type: "event",
      event: event({
        type: "session.snapshot",
        session: {
          conversations: [{ id: 1 }],
          activity: {
            tasks: {
              "4": {
                id: 4,
                kind: "pi.generation",
                conversationId: 1,
                background: false,
                abortRequested: false,
                state: { status: "running", phase: "stream" },
                conversations: [],
              },
            },
          },
        },
      }),
    });

    expect(state.activity?.tasks["4"]).toMatchObject({
      kind: "pi.generation",
      state: { status: "running", phase: "stream" },
    });

    const sleeping = {
      id: 6,
      kind: "app.deliver-scheduled-instruction",
      conversationId: 1,
      background: true,
      abortRequested: false,
      state: { status: "sleeping", phase: "wait", until: 1_800_000_000_000 },
      conversations: [],
    };
    state = sessionReducer(state, {
      type: "event",
      event: event({ type: "session.activity", activity: { tasks: { "6": sleeping } } }),
    });
    expect(state.activity).toEqual({ tasks: { "6": sleeping } });
    expect(() =>
      event({
        type: "session.activity",
        activity: {
          tasks: { "6": { ...sleeping, state: { status: "sleeping", phase: "wait" } } },
        },
      }),
    ).toThrow("Activity sleeping task state is invalid");
    expect(
      event({
        type: "session.activity",
        activity: { tasks: { "6": { ...sleeping, blocked: "missing_task" } } },
      }),
    ).toMatchObject({ activity: { tasks: { "6": { blocked: "missing_task" } } } });
    // Pi Durable 1.5 ends tasks at the restart limit instead of parking them.
    expect(() =>
      event({
        type: "session.activity",
        activity: { tasks: { "6": { ...sleeping, blocked: "restart_limit" } } },
      }),
    ).toThrow("Activity task blocked reason is invalid");

    state = sessionReducer(state, {
      type: "event",
      event: event({ type: "session.activity", activity: { tasks: {} } }),
    });
    expect(state.activity).toEqual({ tasks: {} });

    expect(() =>
      event({
        type: "session.activity",
        activity: {
          tasks: {
            "4": {
              id: 5,
              kind: "pi.generation",
              conversationId: 1,
              background: false,
              abortRequested: false,
              state: { status: "running", phase: "stream" },
              conversations: [],
            },
          },
        },
      }),
    ).toThrow("Activity task key does not match its id");
  });

  it("keeps conversation owners in the session snapshot", () => {
    const state = sessionReducer(initialSessionState, {
      type: "event",
      event: event({
        type: "session.snapshot",
        session: { conversations: [{ id: 1 }, { id: 7, owner: { conversationId: 1 } }] },
      }),
    });
    expect(state.conversations).toEqual([{ id: 1 }, { id: 7, owner: { conversationId: 1 } }]);
    expect(() =>
      event({
        type: "session.snapshot",
        session: { conversations: [{ id: 7, owner: { conversationId: "1" } }] },
      }),
    ).toThrow("conversation.owner.conversationId must be a positive integer");
  });

  it("adds a committed subagent conversation without replacing the session snapshot", () => {
    const initial = sessionReducer(initialSessionState, {
      type: "event",
      event: event({
        type: "session.snapshot",
        session: { conversations: [{ id: 1 }] },
      }),
    });
    const state = sessionReducer(initial, {
      type: "event",
      event: event({
        type: "conversation.created",
        conversation: { id: 7, owner: { conversationId: 1 } },
      }),
    });

    expect(state.conversations).toEqual([{ id: 1 }, { id: 7, owner: { conversationId: 1 } }]);
  });

  it("rejects command results without a valid command discriminator", () => {
    expect(() =>
      event({
        type: "command.result",
        requestId: "prompt-1",
        ok: true,
        conversationId: 1,
      }),
    ).toThrow("Command result command is invalid");
  });

  it("tracks typing presence per conversation", () => {
    let state = sessionReducer(initialSessionState, {
      type: "event",
      event: event({
        type: "presence.typing",
        conversationId: 2,
        usernames: ["Anne", "John"],
      }),
    });
    expect(state.snapshots[2]?.typing).toEqual(["Anne", "John"]);

    state = sessionReducer(state, {
      type: "event",
      event: event({ type: "presence.typing", conversationId: 2, usernames: [] }),
    });
    expect(state.snapshots[2]?.typing).toEqual([]);
  });

  it("validates entry pages in command results", () => {
    expect(
      event({
        type: "command.result",
        command: "conversation.entries",
        requestId: "page-1",
        ok: true,
        conversationId: 1,
        page: { items: [user(2, "Hi")], next: { id: 1 } },
      }),
    ).toMatchObject({ page: { items: [{ id: 2 }], next: { id: 1 } } });
    expect(() =>
      event({
        type: "command.result",
        command: "conversation.entries",
        requestId: "page-1",
        ok: true,
        page: { items: "nope" },
      }),
    ).toThrow("Entries page is invalid");
  });
});
