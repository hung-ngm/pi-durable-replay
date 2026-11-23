import type {
  AgentState,
  CompactionReason,
  InboxState,
  TaskGraph,
  TranscriptItem,
  TranscriptView,
  UsageState,
} from "@earendil-works/pi-durable";
import {
  ROOT_CONVERSATION_ID,
  queuedInputs,
  type ConnectionStatus,
  type ControlView,
  type ConversationSummary,
  type QueuedInput,
  type ServerEvent,
} from "../protocol.ts";
import { liveStateOf, type PiMessage, projectConversation } from "./projection.ts";

export type TranscriptGap = Extract<TranscriptItem, { readonly kind: "gap" }>;

export interface LiveCompaction {
  readonly taskId: number;
  readonly reason: CompactionReason;
  readonly blocking: boolean;
}

export interface ConversationSnapshot {
  readonly id: number;
  readonly messages: readonly PiMessage[];
  readonly isRunning: boolean;
  readonly runTaskId?: number;
  readonly hasEarlier: boolean;
  readonly compactions: readonly LiveCompaction[];
  /** Inputs submitted during a running turn, waiting to be placed after it. */
  readonly queued: readonly QueuedInput[];
  readonly typing: readonly string[];
  readonly agent?: Readonly<AgentState>;
  readonly usage?: Readonly<UsageState>;
}

export interface SessionState {
  readonly status: ConnectionStatus;
  readonly conversations: readonly ConversationSummary[];
  readonly activeConversationId?: number;
  readonly snapshots: Readonly<Record<number, ConversationSnapshot>>;
  readonly activity?: TaskGraph;
  readonly control?: ControlView;
  readonly error?: string;
}

export type SessionAction =
  | { readonly type: "connection"; readonly status: ConnectionStatus }
  | { readonly type: "select"; readonly conversationId: number }
  | { readonly type: "event"; readonly event: ServerEvent }
  | { readonly type: "view"; readonly conversationId: number; readonly view: TranscriptView }
  | { readonly type: "error"; readonly message: string }
  | { readonly type: "clear-error" };

export const OPENS_RESULT_CONVERSATION: ReadonlySet<string> = new Set([
  "conversation.create",
  "run.replayFork",
]);

export const initialSessionState: SessionState = {
  status: "connecting",
  conversations: [],
  snapshots: {},
};

export function sessionReducer(state: SessionState, action: SessionAction): SessionState {
  switch (action.type) {
    case "connection":
      return { ...state, status: action.status };
    case "select":
      return { ...state, activeConversationId: action.conversationId, error: undefined };
    case "error":
      return { ...state, error: action.message };
    case "clear-error":
      return { ...state, error: undefined };
    case "event":
      return reduceServerEvent(state, action.event);
    case "view": {
      const before = state.snapshots[action.conversationId];
      return {
        ...state,
        snapshots: {
          ...state.snapshots,
          [action.conversationId]: conversationSnapshot(
            action.conversationId,
            action.view,
            before?.typing,
            before?.messages,
          ),
        },
      };
    }
  }
}

function reduceServerEvent(state: SessionState, event: ServerEvent): SessionState {
  switch (event.type) {
    case "session.snapshot": {
      const conversations = event.session.conversations;
      const selectedStillExists = conversations.some(({ id }) => id === state.activeConversationId);
      const activeConversationId = selectedStillExists
        ? state.activeConversationId
        : (conversations.find(({ id }) => id === ROOT_CONVERSATION_ID)?.id ?? conversations[0]?.id);
      return {
        ...state,
        conversations,
        activeConversationId,
        ...(event.session.activity === undefined ? {} : { activity: event.session.activity }),
        ...(event.session.control === undefined ? {} : { control: event.session.control }),
      };
    }
    case "conversation.created": {
      const conversations = [
        ...state.conversations.filter(({ id }) => id !== event.conversation.id),
        event.conversation,
      ].sort((left, right) => left.id - right.id);
      return { ...state, conversations };
    }
    case "session.activity":
      return { ...state, activity: event.activity };
    case "conversation.view":
    case "conversation.ops":
      return state;
    case "presence.typing": {
      const before =
        state.snapshots[event.conversationId] ?? emptyConversation(event.conversationId);
      return {
        ...state,
        snapshots: {
          ...state.snapshots,
          [event.conversationId]: { ...before, typing: event.usernames },
        },
      };
    }
    case "command.result":
      if (!event.ok) return { ...state, error: event.error.message };
      return event.conversationId === undefined || !OPENS_RESULT_CONVERSATION.has(event.command)
        ? state
        : { ...state, activeConversationId: event.conversationId, error: undefined };
    case "error":
      return { ...state, error: event.error.message };
  }
}

const emptyConversation = (id: number): ConversationSnapshot => ({
  id,
  messages: [],
  isRunning: false,
  hasEarlier: false,
  compactions: [],
  queued: [],
  typing: [],
});

export function conversationSnapshot(
  id: number,
  view: TranscriptView,
  typing: readonly string[] = [],
  previous: readonly PiMessage[] = [],
): ConversationSnapshot {
  const live = liveStateOf(view);
  const agent = view.docs["pi.agent"] as AgentState | undefined;
  const usage = view.docs["pi.usage"] as unknown as UsageState | undefined;
  return {
    id,
    messages: projectConversation(view, previous),
    isRunning: live.run !== undefined,
    ...(live.run === undefined ? {} : { runTaskId: live.run.taskId }),
    hasEarlier: view.items[0]?.kind === "earlier",
    compactions: (live.compactions ?? []).map(({ taskId, trigger, blocking }) => ({
      taskId,
      reason: trigger,
      blocking,
    })),
    queued: queuedInputs(view.docs["pi.inbox"] as InboxState | undefined),
    typing,
    ...(agent === undefined ? {} : { agent }),
    ...(usage === undefined ? {} : { usage }),
  };
}
