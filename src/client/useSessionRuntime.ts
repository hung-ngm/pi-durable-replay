import { type AppendMessage, useExternalStoreRuntime } from "@assistant-ui/react";
import { type ConversationSummary, ROOT_CONVERSATION_ID } from "../protocol.ts";
import type { PiMessage } from "./projection.ts";
import type { PiSession } from "./usePiSession.ts";

export const conversationLabel = ({ id, parent, owner }: ConversationSummary): string => {
  if (id === ROOT_CONVERSATION_ID) return `Main conversation (id: ${id})`;
  if (owner !== undefined) return `Subagent (id: ${id}, owner: ${owner.conversationId})`;
  if (parent !== undefined) return `Fork (id: ${id}, from: ${parent.at})`;
  return `Conversation (id: ${id})`;
};

const NO_MESSAGES: readonly PiMessage[] = [];

const asThreadMessage = (message: PiMessage): PiMessage => message;

function promptText(message: AppendMessage): string {
  return message.content
    .map((part) => {
      if (part.type !== "text") throw new Error(`Prompts accept text only, not ${part.type}`);
      return part.text;
    })
    .join("\n");
}

export function useSessionRuntime(
  session: PiSession,
  onOpenConversation: (conversationId: number) => void,
) {
  const conversationId = session.activeConversationId;
  const snapshot = session.activeConversation;
  return useExternalStoreRuntime<PiMessage>({
    messages: snapshot?.messages ?? NO_MESSAGES,
    convertMessage: asThreadMessage,
    isRunning: snapshot?.isRunning ?? false,
    isDisabled: session.status !== "connected" || conversationId === undefined,
    hasEarlier: snapshot?.hasEarlier ?? false,
    onLoadEarlier: async () => {
      if (conversationId !== undefined) session.loadEarlier(conversationId);
    },
    onNew: async (message) => {
      if (conversationId === undefined) return;
      await session.submitPrompt(conversationId, promptText(message));
    },
    onCancel: async () => {
      if (snapshot?.runTaskId !== undefined) session.abortTask(snapshot.runTaskId, "run");
    },
    adapters: {
      threadList: {
        threadId: conversationId === undefined ? undefined : String(conversationId),
        threads: session.conversations.map((conversation) => ({
          status: "regular",
          id: String(conversation.id),
          title: conversationLabel(conversation),
        })),
        onSwitchToThread: (threadId) => onOpenConversation(Number(threadId)),
        onSwitchToNewThread: session.createConversation,
      },
    },
  });
}
