import { DurableObject } from "cloudflare:workers";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  type Conversation,
  type ConversationId,
  type ConversationRecord,
  type ConversationView,
  type Cursor,
  defineDocFamily,
  type EntryId,
  Harness,
  type TaskGraph,
  type TaskId,
  type Wake,
  type WatchHandle,
} from "@earendil-works/pi-durable";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { normalizeUsername } from "./identity.ts";
import { createAgentHarnessOptions } from "./agent.ts";
import {
  checkBudgets,
  kill as killControl,
  readControl,
  setBudgets as setControlBudgets,
} from "./control.ts";
import { CrashDoc, LedgerDoc } from "./tools.ts";
import { approveUnsafe, readReplay, replayFork, type ReplayState } from "./replay.ts";
import {
  armCrashLoop,
  clearCrashLoop,
  conversationHasToolResult,
  findLiveToolTask,
  noteCrashLoopAbort,
  readFaults,
} from "./faults.ts";
import { CHARGE_CREDITS_TOOL_NAME, CRASH_LOOP_TOOL_NAME } from "./tools.ts";
import {
  InvalidClientCommand,
  MAX_CLIENT_FRAME_CHARACTERS,
  parseClientCommand,
  type ClientCommand,
  type ControlView,
  type ConversationSummary,
  type ServerEvent,
} from "./protocol.ts";
import { KeyedSerialQueue } from "./serial.ts";

const json = (body: unknown, status: number, headers?: HeadersInit): Response =>
  Response.json(body, { status, headers });

const reportError = (
  message: string,
  error: unknown,
  details: Readonly<Record<string, unknown>> = {},
): void => {
  console.error(
    JSON.stringify({
      message,
      ...details,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
};

/** While work can run, the alarm stays this far ahead, so an evicted instance is woken to resume it. */
const HEARTBEAT_MS = 60_000;
const CONVERSATION_PAGE_SIZE = 100;

type ConversationCommandReceipt =
  | {
      command: "conversation.create";
      conversationId: ConversationId;
    }
  | {
      command: "conversation.fork";
      conversationId: ConversationId;
      parentConversationId: ConversationId;
      entryId: EntryId;
    };

const ConversationCommandReceipts = defineDocFamily<
  {
    receipt?: ConversationCommandReceipt;
  },
  null
>({
  family: true,
  kind: "app.conversation-command-receipt",
  version: 1,
  scope: "session",
  initial: () => ({}),
  // Written once per request ID, so there is no delta history to bound.
  checkpointWhen: () => false,
});

type SessionConnectionState = {
  readonly username: string;
  readonly conversationId?: number;
  readonly typing?: true;
};

type LegacyPartyServerAttachment = {
  readonly __user?: unknown;
};

type WSMessage = string | ArrayBuffer;

const isSessionConnectionState = (value: unknown): value is SessionConnectionState => {
  if (typeof value !== "object" || value === null || !("username" in value)) return false;
  const state = value as Record<string, unknown>;
  return (
    typeof state.username === "string" &&
    (state.conversationId === undefined ||
      (typeof state.conversationId === "number" &&
        Number.isSafeInteger(state.conversationId) &&
        state.conversationId > 0)) &&
    (state.typing === undefined || state.typing === true)
  );
};

const connectionState = (socket: WebSocket): SessionConnectionState | null => {
  const attachment: unknown = socket.deserializeAttachment();
  // Hibernated sockets can survive a deployment from the former PartyServer implementation.
  if (isSessionConnectionState(attachment)) return attachment;
  if (typeof attachment !== "object" || attachment === null || !("__user" in attachment)) {
    return null;
  }
  const legacy = attachment as LegacyPartyServerAttachment;
  return isSessionConnectionState(legacy.__user) ? legacy.__user : null;
};

const setConnectionState = (socket: WebSocket, state: SessionConnectionState): void => {
  socket.serializeAttachment(state);
};

const usernameForConnection = (connectionId: string, request: Request): string => {
  const requested = new URL(request.url).searchParams.get("username") ?? "";
  const username = normalizeUsername(requested);
  if (username.length > 0) return username;
  const suffix = connectionId.replace(/[^a-z0-9]/giu, "").slice(0, 6) || "guest";
  return `Guest-${suffix}`;
};

const isReservedCloseCode = (code: number): boolean =>
  code === 1005 || code === 1006 || code === 1015;

const reciprocateClose = (socket: WebSocket, code: number, reason: string): void => {
  if (isReservedCloseCode(code)) return;
  try {
    socket.close(code, reason);
  } catch {
    // The socket is already closed or the peer is no longer reachable.
  }
};

const attributedPrompt = (username: string, content: string): string => `[${username}]\n${content}`;

const conversationSummary = (conversation: ConversationRecord): ConversationSummary => ({
  id: conversation.id,
  ...(conversation.parent === undefined
    ? {}
    : {
        parent: {
          conversationId: conversation.parent.conversationId,
          at: conversation.parent.at,
        },
      }),
  ...(conversation.owner === undefined
    ? {}
    : { owner: { conversationId: conversation.owner.conversationId } }),
});

export class Session extends DurableObject<Env> {
  #harness!: Harness;
  #activity!: WatchHandle<TaskGraph>;
  readonly #views = new Map<WebSocket, WatchHandle<ConversationView>>();
  readonly #typingConnections = new Set<WebSocket>();
  readonly #connectionOperations = new KeyedSerialQueue<WebSocket>();
  #alarmWrites: Promise<void> = Promise.resolve();
  /**
   * While the crash-loop fault is armed, the recovery heartbeat runs at 2s
   * instead of 60s: each cut is followed by a wake, a resume, and the next
   * cut, and a 60s cadence would stretch the demo over five minutes. (An
   * alarm set immediately before ctx.abort does not reliably drive the next
   * cycle in the test pool; the heartbeat path does.)
   */
  #fastHeartbeat = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(() => this.#initialize());
  }

  async #initialize(): Promise<void> {
    // A fallback before anything can throw: an object whose open or recovery fails is started again.
    const fallback = Date.now() + HEARTBEAT_MS;
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > fallback) await this.ctx.storage.setAlarm(fallback);

    const storage = await openDurableObjectSqliteStorage(this.ctx.storage);
    const harness = await Harness.open(
      storage,
      {
        ...createAgentHarnessOptions({
          searchBackend: this.env.SEARCH_BACKEND ?? "corpus",
          ...(this.env.EXA_API_KEY === undefined ? {} : { exaApiKey: this.env.EXA_API_KEY }),
        }),
        // `kind` says what happened, e.g. `task_faulted` or `task_interrupted`, with the task and extension.
        onReport: ({ error, ...report }) =>
          reportError("Harness reported a failure", error, report),
        // Called after open and whenever the next wake changes. With `onWake`, the Harness keeps no timer for
        // sleeps: the alarm calls `resume()`. A failed alarm write resets the object; it arms again on restart.
        onWake: (wake) => void this.#arm(wake).catch(() => this.ctx.abort("Alarm write failed")),
      },
      BACKGROUND_CONTEXT,
    );

    // A storage error closes the harness. Reset the object so the next event reopens it.
    void harness.closed.then((end) => {
      if (end.kind === "failed") this.ctx.abort("Harness failed");
    });

    let activity: WatchHandle<TaskGraph> | undefined;
    try {
      this.#harness = harness;
      activity = await harness.watchTaskGraph(BACKGROUND_CONTEXT);
      this.#activity = activity;
      activity.start(async (call) => {
        if (call.kind === "value") {
          this.#broadcast({ type: "session.activity", activity: call.value });
          this.#scheduleBudgetCheck();
          this.#scheduleCrashLoopCheck();
        }
      });
      // Subagents are created by background tool tasks, not client commands.
      // Notify connected clients when their conversation records are committed.
      harness.observeCommits({
        advance: (publication) => {
          this.#scheduleBudgetCheck();
          this.#scheduleCrashLoopCheck();
          for (const change of publication.changes) {
            if (change.type !== "conversation" || change.value.owner === undefined) continue;
            this.#broadcast({
              type: "conversation.created",
              conversation: conversationSummary(change.value),
            });
          }
        },
        end: () => {},
      });
      await this.#restoreViews();
      this.#fastHeartbeat =
        (await readFaults(harness, BACKGROUND_CONTEXT)).crashLoopConversationId !== undefined;
      // Armed before `resume()` runs anything, as for any call that can start work.
      await this.#arm(harness.wake());
      // Continue work a lost instance left, and make due sleeps runnable.
      harness.resume();
    } catch (error) {
      await activity?.stop();
      await harness.close(BACKGROUND_CONTEXT);
      throw error;
    }
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.method !== "GET") {
      return json({ error: "Method not allowed" }, 405, { Allow: "GET" });
    }
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return json({ error: "WebSocket upgrade required" }, 426, { Upgrade: "websocket" });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const connectionId = new URL(request.url).searchParams.get("_pk") || crypto.randomUUID();

    this.ctx.acceptWebSocket(server);
    setConnectionState(server, { username: usernameForConnection(connectionId, request) });
    try {
      await this.#connect(server);
    } catch (error) {
      reportError("Session WebSocket connection failed", error);
      try {
        server.close(1011, "Session setup failed");
      } catch {
        // The accepted socket may already have closed while setup was running.
      }
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  override async alarm(): Promise<void> {
    // Armed before `resume()` can start work, as on open.
    await this.#arm({ ...this.#harness.wake(), active: true });
    this.#harness.resume();
    // Alarms are at-least-once, and `onWake` repeats no unchanged wake: an early or spurious alarm would otherwise
    // leave the heartbeat armed with nothing to do. `wake()` already counts the work `resume()` made runnable.
    await this.#arm(this.#harness.wake());
  }

  override async webSocketMessage(socket: WebSocket, message: WSMessage): Promise<void> {
    try {
      await this.#connectionOperations.run(socket, () => this.#processMessage(socket, message));
    } catch (error) {
      reportError("Session WebSocket message failed", error);
    }
  }

  async #processMessage(socket: WebSocket, message: WSMessage): Promise<void> {
    if (typeof message !== "string") {
      this.#send(socket, {
        type: "error",
        error: { code: "invalid_message", message: "Binary messages are not supported" },
      });
      socket.close(1002, "Binary protocol frame");
      return;
    }

    if (message.length > MAX_CLIENT_FRAME_CHARACTERS) {
      this.#send(socket, {
        type: "error",
        error: { code: "frame_too_large", message: "Command frame exceeds the size limit" },
      });
      socket.close(1009, "Command frame too large");
      return;
    }

    let command: ClientCommand;
    try {
      command = parseClientCommand(message);
    } catch (error) {
      if (!(error instanceof InvalidClientCommand)) throw error;
      this.#send(socket, {
        type: "error",
        error: { code: "invalid_command", message: error.message },
      });
      socket.close(1002, "Invalid command frame");
      return;
    }

    try {
      await this.#handleCommand(socket, command);
    } catch (error) {
      reportError("Session command failed", error, { command: command.type });
      if (command.type === "presence.typing") return;
      this.#send(socket, {
        type: "command.result",
        command: command.type,
        requestId: command.requestId,
        ok: false,
        error: {
          code: "command_failed",
          message: error instanceof Error ? error.message : "Command failed",
        },
      });
    }
  }

  override async webSocketClose(
    socket: WebSocket,
    code: number,
    reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    try {
      await this.#connectionOperations.run(socket, async () => {
        this.#setTyping(socket, false);
        await this.#stopView(socket);
      });
    } catch (error) {
      reportError("Session WebSocket close failed", error);
    } finally {
      reciprocateClose(socket, code, reason);
    }
  }

  override async webSocketError(socket: WebSocket, error: unknown): Promise<void> {
    try {
      await this.#connectionOperations.run(socket, async () => {
        reportError("Session WebSocket failed", error);
        this.#setTyping(socket, false);
        await this.#stopView(socket);
      });
    } catch (handlerError) {
      reportError("Session WebSocket error cleanup failed", handlerError);
    }
  }

  async #connect(server: WebSocket): Promise<void> {
    const root = await this.#harness.root(BACKGROUND_CONTEXT);
    await this.#sendSessionSnapshot(server);
    await this.#watchConversation(server, root.id);
  }

  async #handleCommand(socket: WebSocket, command: ClientCommand): Promise<void> {
    switch (command.type) {
      case "presence.typing":
        if (connectionState(socket)?.conversationId === command.conversationId) {
          this.#setTyping(socket, command.typing);
        }
        return;
      case "conversation.open":
        await this.#requireConversation(command.conversationId as ConversationId);
        await this.#watchConversation(socket, command.conversationId as ConversationId);
        this.#send(socket, {
          type: "command.result",
          command: command.type,
          requestId: command.requestId,
          ok: true,
        });
        return;
      case "conversation.entries": {
        const conversation = await this.#requireConversation(
          command.conversationId as ConversationId,
        );
        const page = await conversation.entries(
          {
            ...(command.minEntryId === undefined
              ? {}
              : { minEntryId: command.minEntryId as EntryId }),
            ...(command.maxEntryId === undefined
              ? {}
              : { maxEntryId: command.maxEntryId as EntryId }),
            order: command.order,
          },
          command.limit,
          undefined,
          BACKGROUND_CONTEXT,
        );
        this.#send(socket, {
          type: "command.result",
          command: command.type,
          requestId: command.requestId,
          ok: true,
          conversationId: conversation.id,
          page: { items: page.items, ...(page.next === undefined ? {} : { next: page.next }) },
        });
        return;
      }
      case "conversation.create": {
        const conversationId = await this.#harness.commit(async (tx) => {
          const doc = await tx.doc(ConversationCommandReceipts, command.requestId, null);
          const existing = doc.receipt;
          if (existing !== undefined) {
            if (existing.command !== command.type) {
              throw new Error(
                `Request ${command.requestId} was already used for ${existing.command}`,
              );
            }
            return existing.conversationId;
          }
          const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
          doc.receipt = {
            command: command.type,
            conversationId: conversation.id,
          };
          return conversation.id;
        }, BACKGROUND_CONTEXT);
        await this.#watchConversation(socket, conversationId);
        await this.#broadcastSessionSnapshot();
        this.#send(socket, {
          type: "command.result",
          command: command.type,
          requestId: command.requestId,
          ok: true,
          conversationId,
        });
        return;
      }
      case "conversation.fork": {
        const parentConversationId = command.conversationId as ConversationId;
        const entryId = command.entryId as EntryId;
        const conversationId = await this.#harness.commit(async (tx) => {
          const doc = await tx.doc(ConversationCommandReceipts, command.requestId, null);
          const existing = doc.receipt;
          if (existing !== undefined) {
            if (
              existing.command !== command.type ||
              existing.parentConversationId !== parentConversationId ||
              existing.entryId !== entryId
            ) {
              throw new Error(`Request ${command.requestId} was already used for another command`);
            }
            return existing.conversationId;
          }
          const fork = await tx.forkConversation(parentConversationId, entryId, {
            ownership: { kind: "ownerless" },
          });
          doc.receipt = {
            command: command.type,
            conversationId: fork.id,
            parentConversationId,
            entryId,
          };
          return fork.id;
        }, BACKGROUND_CONTEXT);
        await this.#watchConversation(socket, conversationId);
        await this.#broadcastSessionSnapshot();
        this.#send(socket, {
          type: "command.result",
          command: command.type,
          requestId: command.requestId,
          ok: true,
          conversationId,
        });
        return;
      }
      case "prompt.submit": {
        this.#setTyping(socket, false);
        const conversation = await this.#requireConversation(
          command.conversationId as ConversationId,
        );
        // Arm before admitting work: `onWake` runs after the commit, so an instance that dies in between is
        // still woken. An early alarm is harmless; a missing one strands the turn.
        await this.#arm({ ...this.#harness.wake(), active: true });
        const submission = await conversation.submit(
          {
            type: "input",
            content: attributedPrompt(
              connectionState(socket)?.username ?? "Guest",
              command.content,
            ),
            requestId: command.requestId,
            // Queue behind a running turn instead of rejecting; the inbox places it after the current answer.
            whenBusy: "followUp",
          },
          BACKGROUND_CONTEXT,
        );
        this.#send(socket, {
          type: "command.result",
          command: command.type,
          requestId: command.requestId,
          ok: true,
          conversationId: conversation.id,
          submissionId: submission.id,
        });
        return;
      }
      case "task.abort": {
        await killControl(
          this.#harness,
          this.#activity.value,
          {
            scope: command.scope,
            taskId: command.taskId as TaskId,
            reason: "manual",
          },
          BACKGROUND_CONTEXT,
        );
        await this.#broadcastSessionSnapshot();
        this.#send(socket, {
          type: "command.result",
          command: command.type,
          requestId: command.requestId,
          ok: true,
        });
        return;
      }
      case "conversation.abort": {
        await killControl(
          this.#harness,
          this.#activity.value,
          {
            scope: "conversation",
            conversationId: command.conversationId as ConversationId,
            reason: "manual",
          },
          BACKGROUND_CONTEXT,
        );
        await this.#broadcastSessionSnapshot();
        this.#send(socket, {
          type: "command.result",
          command: command.type,
          requestId: command.requestId,
          ok: true,
          conversationId: command.conversationId,
        });
        return;
      }
      case "session.abort": {
        await killControl(
          this.#harness,
          this.#activity.value,
          { scope: "all", reason: "manual" },
          BACKGROUND_CONTEXT,
        );
        await this.#broadcastSessionSnapshot();
        this.#send(socket, {
          type: "command.result",
          command: command.type,
          requestId: command.requestId,
          ok: true,
        });
        return;
      }
      case "fault.inject": {
        const conversationId = command.conversationId as ConversationId;
        if (command.kind === "interrupt-unsafe") {
          const taskId = await findLiveToolTask(
            this.#harness,
            conversationId,
            CHARGE_CREDITS_TOOL_NAME,
            BACKGROUND_CONTEXT,
          );
          if (taskId !== undefined) {
            await killControl(
              this.#harness,
              this.#activity.value,
              { scope: "tool", conversationId, taskId, reason: "manual" },
              BACKGROUND_CONTEXT,
            );
          }
          await this.#broadcastSessionSnapshot();
          this.#send(
            socket,
            taskId === undefined
              ? {
                  type: "command.result",
                  command: command.type,
                  requestId: command.requestId,
                  ok: false,
                  error: {
                    code: "no_live_unsafe_tool",
                    message: "No charge_credits call is running in this conversation.",
                  },
                }
              : {
                  type: "command.result",
                  command: command.type,
                  requestId: command.requestId,
                  ok: true,
                  conversationId,
                },
          );
          return;
        }
        if (command.kind === "crash-loop") {
          await armCrashLoop(this.#harness, conversationId, BACKGROUND_CONTEXT);
          this.#fastHeartbeat = true;
          const conversation = await this.#requireConversation(conversationId);
          await this.#arm({ ...this.#harness.wake(), active: true });
          await conversation.submit(
            {
              type: "input",
              content:
                'Call the crash_loop tool with topic "fault injection" now. Do not answer any other way.',
              requestId: command.requestId,
            },
            BACKGROUND_CONTEXT,
          );
          this.#send(socket, {
            type: "command.result",
            command: command.type,
            requestId: command.requestId,
            ok: true,
            conversationId,
          });
          return;
        }
        // Evict: reply first, arm a near-immediate alarm so the object wakes and
        // resumes through it, then cut this instance off.
        this.#send(socket, {
          type: "command.result",
          command: command.type,
          requestId: command.requestId,
          ok: true,
          conversationId,
        });
        await this.ctx.storage.setAlarm(Date.now() + 250);
        this.ctx.abort("Fault injection: eviction");
        return;
      }
      case "run.replayFork": {
        const result = await replayFork(
          this.#harness,
          command.conversationId as ConversationId,
          command.entryId as EntryId,
          BACKGROUND_CONTEXT,
        );
        await this.#watchConversation(socket, result.conversationId);
        await this.#broadcastSessionSnapshot();
        this.#send(socket, {
          type: "command.result",
          command: command.type,
          requestId: command.requestId,
          ok: true,
          conversationId: result.conversationId,
        });
        return;
      }
      case "run.approveUnsafe": {
        await approveUnsafe(
          this.#harness,
          command.conversationId as ConversationId,
          BACKGROUND_CONTEXT,
        );
        await this.#broadcastSessionSnapshot();
        this.#send(socket, {
          type: "command.result",
          command: command.type,
          requestId: command.requestId,
          ok: true,
          conversationId: command.conversationId,
        });
        return;
      }
      case "control.setBudgets": {
        await setControlBudgets(
          this.#harness,
          { tokenBudget: command.tokenBudget, turnBudget: command.turnBudget },
          BACKGROUND_CONTEXT,
        );
        await this.#broadcastSessionSnapshot();
        this.#send(socket, {
          type: "command.result",
          command: command.type,
          requestId: command.requestId,
          ok: true,
        });
        return;
      }
    }
  }

  #budgetCheckRunning = false;
  #budgetCheckPending = false;

  /** Run the budget guard off the commit path; coalesce bursts into one recheck. */
  #scheduleBudgetCheck(): void {
    if (this.#budgetCheckRunning) {
      this.#budgetCheckPending = true;
      return;
    }
    this.#budgetCheckRunning = true;
    void (async () => {
      try {
        do {
          this.#budgetCheckPending = false;
          const kills = await checkBudgets(this.#harness, this.#activity.value, BACKGROUND_CONTEXT);
          if (kills.length > 0) await this.#broadcastSessionSnapshot();
        } while (this.#budgetCheckPending);
      } catch (error) {
        reportError("Budget check failed", error);
      } finally {
        this.#budgetCheckRunning = false;
      }
    })();
  }

  #crashLoopCheckRunning = false;
  #crashLoopCheckPending = false;

  /**
   * While the crash-loop fault is armed, cut the object off (an eviction) every
   * time the crash_loop tool is seen running, until its result lands at the
   * restart limit. The arm lives in FaultDoc because it must survive the cuts.
   */
  #scheduleCrashLoopCheck(): void {
    if (this.#crashLoopCheckRunning) {
      this.#crashLoopCheckPending = true;
      return;
    }
    this.#crashLoopCheckRunning = true;
    void (async () => {
      try {
        do {
          this.#crashLoopCheckPending = false;
          const faults = await readFaults(this.#harness, BACKGROUND_CONTEXT);
          const conversationId = faults.crashLoopConversationId;
          if (conversationId === undefined) continue;
          const target = conversationId as ConversationId;
          const ended = await conversationHasToolResult(
            this.#harness,
            target,
            CRASH_LOOP_TOOL_NAME,
            "restart_limit",
            BACKGROUND_CONTEXT,
          );
          if (ended || faults.aborts >= 12) {
            await clearCrashLoop(this.#harness, BACKGROUND_CONTEXT);
            this.#fastHeartbeat = false;
            continue;
          }
          const taskId = await findLiveToolTask(
            this.#harness,
            target,
            CRASH_LOOP_TOOL_NAME,
            BACKGROUND_CONTEXT,
          );
          if (taskId === undefined) continue;
          // Cut only a fresh execution: the tool increments CrashDoc at the
          // start of every run, so an attempt beyond the last cut is real work
          // in flight, not a pending task that has not started yet.
          const attempts =
            (await this.#harness.snapshot(CrashDoc, BACKGROUND_CONTEXT))?.attempts ?? 0;
          if (attempts <= (faults.attemptsAtLastAbort ?? 0)) continue;
          if (faults.lastAbortAt !== undefined && Date.now() - faults.lastAbortAt < 600) continue;
          await noteCrashLoopAbort(this.#harness, attempts, BACKGROUND_CONTEXT);
          await this.ctx.storage.setAlarm(Date.now() + 250);
          this.ctx.abort("Fault injection: crash loop");
          return;
        } while (this.#crashLoopCheckPending);
      } catch (error) {
        reportError("Crash-loop check failed", error);
      } finally {
        this.#crashLoopCheckRunning = false;
      }
    })();
  }

  async #requireConversation(id: ConversationId): Promise<Conversation> {
    const conversation = await this.#harness.conversation(id, BACKGROUND_CONTEXT);
    if (conversation === undefined) throw new Error(`Conversation ${id} does not exist`);
    return conversation;
  }

  async #sendSessionSnapshot(socket: WebSocket): Promise<void> {
    this.#send(socket, {
      type: "session.snapshot",
      session: {
        conversations: await this.#sessionSnapshot(),
        activity: this.#activity.value,
        control: await this.#controlView(),
      },
    });
  }

  async #broadcastSessionSnapshot(): Promise<void> {
    this.#broadcast({
      type: "session.snapshot",
      session: {
        conversations: await this.#sessionSnapshot(),
        activity: this.#activity.value,
        control: await this.#controlView(),
      },
    });
  }

  async #controlView(): Promise<ControlView> {
    const control = await readControl(this.#harness, BACKGROUND_CONTEXT);
    const ledger = await this.#harness.commit(async (tx) => {
      const doc = await tx.doc(LedgerDoc);
      return doc.entries.map((entry) => ({ ...entry }));
    }, BACKGROUND_CONTEXT);
    const conversations = await this.#sessionSnapshot();
    const replays: Record<string, ReplayState> = {};
    for (const conversation of conversations) {
      const replay = await readReplay(
        this.#harness,
        conversation.id as ConversationId,
        BACKGROUND_CONTEXT,
      );
      if (replay !== undefined) replays[String(conversation.id)] = replay;
    }
    const crashAttempts =
      (await this.#harness.snapshot(CrashDoc, BACKGROUND_CONTEXT))?.attempts ?? 0;
    return {
      tokenBudget: control.tokenBudget,
      turnBudget: control.turnBudget,
      kills: control.kills,
      ledger,
      replays,
      crashAttempts,
    };
  }

  #sessionSnapshot(): Promise<readonly ConversationSummary[]> {
    return this.#harness.commit(async (tx) => {
      const conversations: ConversationSummary[] = [];
      let cursor: Cursor | undefined;
      do {
        const page = await tx.scanConversations({}, CONVERSATION_PAGE_SIZE, cursor);
        conversations.push(...page.items.map(conversationSummary));
        cursor = page.next;
      } while (cursor !== undefined);
      return conversations;
    }, BACKGROUND_CONTEXT);
  }

  async #watchConversation(
    socket: WebSocket,
    conversationId: ConversationId,
    restoreTyping = false,
  ): Promise<void> {
    this.#setTyping(socket, false);
    await this.#stopView(socket);
    const username = connectionState(socket)?.username ?? "Guest";
    setConnectionState(socket, { username });
    const conversation = await this.#requireConversation(conversationId);
    // A window over the transcript and the conversation's built-in documents: the run, the streamed answer, tool
    // progress, the queue, the agent, and usage. The client pages older entries with `conversation.entries`.
    const view = await conversation.watch(BACKGROUND_CONTEXT);
    this.#views.set(socket, view);
    setConnectionState(socket, {
      username,
      conversationId,
      ...(restoreTyping ? { typing: true } : {}),
    });
    if (restoreTyping) this.#typingConnections.add(socket);
    this.#send(socket, { type: "conversation.view", conversationId, view: view.value });
    view.start(async (call) => {
      if (this.#views.get(socket) !== view || call.kind !== "value") return;
      this.#send(socket, { type: "conversation.ops", conversationId, ops: call.ops });
    });
    void view.closed.finally(() => {
      if (this.#views.get(socket) === view) this.#views.delete(socket);
    });
    this.#broadcastTyping(conversationId);
  }

  async #stopView(socket: WebSocket): Promise<void> {
    const view = this.#views.get(socket);
    if (view === undefined) return;
    this.#views.delete(socket);
    await view.stop();
  }

  async #restoreViews(): Promise<void> {
    for (const socket of this.#connections()) {
      const attachment = connectionState(socket);
      if (attachment?.conversationId !== undefined) {
        const conversationId = attachment.conversationId as ConversationId;
        await this.#watchConversation(socket, conversationId, attachment.typing === true);
      }
    }
  }

  #connections(): WebSocket[] {
    return this.ctx
      .getWebSockets()
      .filter((socket) => socket.readyState === WebSocket.READY_STATE_OPEN);
  }

  #broadcast(event: ServerEvent): void {
    const message = JSON.stringify(event);
    for (const socket of this.#connections()) this.#sendMessage(socket, message);
  }

  #send(socket: WebSocket, event: ServerEvent): void {
    this.#sendMessage(socket, JSON.stringify(event));
  }

  #sendMessage(socket: WebSocket, message: string): void {
    if (socket.readyState !== WebSocket.READY_STATE_OPEN) return;
    try {
      socket.send(message);
    } catch {
      try {
        socket.close(1011, "Unexpected send error");
      } catch {
        // The socket may already have closed after the ready-state check.
      }
    }
  }

  #setTyping(socket: WebSocket, typing: boolean): void {
    const state = connectionState(socket);
    if (state === null || state.conversationId === undefined) return;
    const conversationId = state.conversationId;
    const changed = typing
      ? !this.#typingConnections.has(socket)
      : this.#typingConnections.delete(socket);
    if (typing) this.#typingConnections.add(socket);
    if (socket.readyState === WebSocket.READY_STATE_OPEN) {
      setConnectionState(socket, {
        username: state.username,
        conversationId,
        ...(typing ? { typing: true } : {}),
      });
    }
    if (changed) this.#broadcastTyping(conversationId as ConversationId);
  }

  #broadcastTyping(conversationId: ConversationId): void {
    const connections = this.#connections().filter(
      (connection) => connectionState(connection)?.conversationId === conversationId,
    );
    const typers = connections.filter((connection) => this.#typingConnections.has(connection));
    for (const receiver of connections) {
      const usernames = [
        ...new Set(
          typers
            .filter((connection) => connection !== receiver)
            .map((connection) => connectionState(connection)?.username)
            .filter((username): username is string => username !== undefined),
        ),
      ].sort((left, right) => left.localeCompare(right));
      this.#send(receiver, { type: "presence.typing", conversationId, usernames });
    }
  }

  /** The one alarm: the earliest sleep, or a recovery heartbeat while work can run, whichever comes first. */
  #arm(wake: Wake): Promise<void> {
    // Serialized, so an older wake cannot overwrite a newer, earlier deadline.
    const write = this.#alarmWrites.then(async () => {
      const heartbeat = wake.active
        ? Date.now() + (this.#fastHeartbeat ? 2_000 : HEARTBEAT_MS)
        : undefined;
      // `wake.at` is on the Harness clock, which is the default `Date.now`.
      const at =
        heartbeat === undefined || wake.at === undefined
          ? (heartbeat ?? wake.at)
          : Math.min(heartbeat, wake.at);
      if (at === undefined) await this.ctx.storage.deleteAlarm();
      else await this.ctx.storage.setAlarm(at);
    });
    this.#alarmWrites = write.catch(() => undefined);
    return write;
  }
}
