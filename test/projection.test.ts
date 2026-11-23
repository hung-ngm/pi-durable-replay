import { ConversationTranscript, type ConversationView } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import {
  initialSessionState,
  sessionReducer,
  type SessionState,
} from "../src/client/session-state.ts";
import { withReplayApproval } from "../src/client/projection.ts";

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const assistantMessage = (content: readonly object[], stopReason = "stop") => ({
  role: "assistant",
  content,
  api: "faux",
  provider: "faux",
  model: "faux",
  usage,
  stopReason,
  timestamp: 2,
});

const user = (id: number, content: string) => ({
  id,
  conversationId: 1,
  kind: "pi.user",
  model: [{ role: "user", content, timestamp: 1 }],
});

const assistant = (id: number, text: string) => ({
  id,
  conversationId: 1,
  kind: "pi.assistant",
  model: [assistantMessage([{ type: "text", text }])],
});

const toolRequest = (id: number, callId: string, name: string) => ({
  id,
  conversationId: 1,
  kind: "pi.assistant",
  model: [
    assistantMessage(
      [
        { type: "text", text: "Checking." },
        { type: "toolCall", id: callId, name, arguments: { query: "solar" } },
      ],
      "toolUse",
    ),
  ],
});

const toolResult = (id: number, callId: string, name: string, text: string) => ({
  id,
  conversationId: 1,
  kind: "pi.tool-result",
  model: [
    {
      role: "toolResult",
      toolCallId: callId,
      toolName: name,
      content: [
        { type: "text", text },
        { type: "text", text: "<harness>\n[warn] Output truncated\n</harness>" },
      ],
      isError: false,
      timestamp: 3,
    },
  ],
  data: { diagnostics: [{ severity: "warn", message: "Output truncated" }] },
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

const transcript = () => new ConversationTranscript(async () => ({ items: [] }));

const show = (
  state: SessionState,
  view: ConversationView,
  client: ConversationTranscript = transcript(),
): SessionState =>
  sessionReducer(state, { type: "view", conversationId: 1, view: client.merge(view) });

const messagesOf = (state: SessionState) => state.snapshots[1]?.messages ?? [];

describe("conversation projection", () => {
  it("projects committed entries as messages that carry their entry ID", () => {
    const state = show(initialSessionState, viewOf([user(2, "Hello"), assistant(3, "Hi")]));
    expect(messagesOf(state)).toMatchObject([
      {
        id: "entry:2:0",
        role: "user",
        content: [{ type: "text", text: "Hello" }],
        metadata: { custom: { conversationId: 1, entryId: 2 } },
      },
      {
        id: "entry:3:0",
        role: "assistant",
        content: [{ type: "text", text: "Hi" }],
        status: { type: "complete" },
        metadata: { custom: { conversationId: 1, entryId: 3 } },
      },
    ]);
  });

  it("joins a tool result into its call, without the rendered diagnostics block", () => {
    const state = show(
      initialSessionState,
      viewOf([
        toolRequest(3, "call-1", "search"),
        toolResult(4, "call-1", "search", "Three sources"),
      ]),
    );
    const messages = messagesOf(state);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      id: "entry:3:0",
      content: [
        { type: "text", text: "Checking." },
        {
          type: "tool-call",
          toolCallId: "call-1",
          toolName: "search",
          args: { query: "solar" },
          result: "Three sources",
          isError: false,
          artifact: { diagnostics: [{ severity: "warn", message: "Output truncated" }] },
        },
      ],
    });
  });

  it("streams the live answer as one running message and keeps committed messages identical", () => {
    const live = (text: string) => ({
      "pi.live": {
        run: { taskId: 5, inputs: [2], turns: 0 },
        generation: { attempt: 1, message: assistantMessage([{ type: "text", text }]) },
      },
    });
    const client = transcript();
    const first = show(initialSessionState, viewOf([user(2, "Hello")], live("Hel")), client);
    expect(first.snapshots[1]).toMatchObject({ isRunning: true, runTaskId: 5 });
    expect(messagesOf(first)).toMatchObject([
      { id: "entry:2:0" },
      { id: "generation:5", role: "assistant", status: { type: "running" } },
    ]);

    const second = show(first, viewOf([user(2, "Hello")], live("Hello")), client);
    expect(messagesOf(second)[0]).toBe(messagesOf(first)[0]);
    expect(messagesOf(second)[1]).toMatchObject({ content: [{ type: "text", text: "Hello" }] });

    const committed = show(second, viewOf([user(2, "Hello"), assistant(4, "Hello")]), client);
    expect(committed.snapshots[1]).toMatchObject({ isRunning: false });
    expect(messagesOf(committed).map(({ id }) => id)).toEqual(["entry:2:0", "entry:4:0"]);
    expect(messagesOf(committed)[0]).toBe(messagesOf(first)[0]);
  });

  it("shows a running tool's progress on its committed call", () => {
    const state = show(
      initialSessionState,
      viewOf([toolRequest(3, "call-1", "slow_search")], {
        "pi.live": {
          run: { taskId: 5, inputs: [2], turns: 1 },
          tools: [
            {
              callId: "call-1",
              name: "slow_search",
              status: "running",
              taskId: 8,
              output: "stage 2 of 3",
            },
          ],
        },
      }),
    );
    expect(messagesOf(state)).toMatchObject([
      {
        id: "entry:3:0",
        status: { type: "running" },
        content: [
          { type: "text" },
          { type: "tool-call", toolCallId: "call-1", result: "stage 2 of 3", isPreliminary: true },
        ],
      },
    ]);
  });

  it("marks a call left without a result as cancelled once no run is live", () => {
    const state = show(initialSessionState, viewOf([toolRequest(3, "call-1", "slow_search")]));
    expect(messagesOf(state)[0]?.status).toEqual({ type: "incomplete", reason: "cancelled" });
  });

  it("reports why a run ended without a result, aborts included", () => {
    const state = show(
      initialSessionState,
      viewOf([user(2, "Hello")], {
        "pi.live": { runFailure: { taskId: 9, inputs: [2], reason: "aborted" } },
      }),
    );
    expect(messagesOf(state).at(-1)).toMatchObject({
      id: "failure:9",
      role: "assistant",
      status: { type: "incomplete", reason: "error", error: "The run was aborted" },
    });
  });

  it("places a missing range after the entry it follows", () => {
    const client = transcript();
    let state = show(
      initialSessionState,
      viewOf([user(11, "Eleven"), user(12, "Twelve")], {}, 10),
      client,
    );
    expect(state.snapshots[1]?.hasEarlier).toBe(true);
    state = show(state, viewOf([user(20, "Twenty")], {}, 15), client);
    expect(messagesOf(state).map(({ id }) => id)).toEqual([
      "entry:11:0",
      "entry:12:0",
      "gap:12",
      "entry:20:0",
    ]);
    expect(messagesOf(state)[2]?.content).toEqual([
      { type: "data-pi-gap", data: { kind: "gap", after: 12, upTo: 20 } },
    ]);
  });

  it("shows compaction summaries as context notes", () => {
    const state = show(
      initialSessionState,
      viewOf([
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
        },
      ]),
    );
    expect(messagesOf(state)).toMatchObject([
      {
        id: "entry:5:notice",
        content: [
          {
            type: "data-pi-context",
            data: { kind: "compaction", text: "User asked about weather." },
          },
        ],
      },
    ]);
  });
});

describe("Fork Replay approval on the blocked charge", () => {
  const blockedCharge = (id: number, callId: string) => {
    const message =
      "Tool call blocked: charge_credits is blocked in this replay: conversation #1 already charged.";
    const entry = toolResult(id, callId, "charge_credits", "");
    return {
      ...entry,
      model: [
        {
          ...entry.model[0],
          content: [{ type: "text", text: `<harness>\n[error] ${message}\n</harness>` }],
          isError: true,
        },
      ],
      data: { diagnostics: [{ severity: "error", code: "blocked", message }] },
    };
  };
  const replay = {
    sourceConversationId: 1,
    forkEntryId: 3,
    carried: [],
    pendingUnsafeApproval: true,
  };
  const messages = messagesOf(
    show(
      initialSessionState,
      viewOf([toolRequest(5, "call-9", "charge_credits"), blockedCharge(6, "call-9")]),
    ),
  );
  const chargeOf = (projected: typeof messages) =>
    projected[0]?.content.find((part) => part.type === "tool-call");

  it("asks for approval on the blocked call, then reads approved once the replay records it", () => {
    expect(chargeOf(withReplayApproval(messages, 7, replay))).toMatchObject({
      approval: { id: "replay:7", approved: undefined },
    });
    expect(
      chargeOf(
        withReplayApproval(messages, 7, { ...replay, pendingUnsafeApproval: false, approvedAt: 9 }),
      ),
    ).toMatchObject({ approval: { id: "replay:7", approved: true } });
  });

  it("leaves a conversation that is not a replay untouched", () => {
    expect(withReplayApproval(messages, 7, undefined)).toBe(messages);
  });
});
