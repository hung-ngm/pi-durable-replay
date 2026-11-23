import { type AppendMessage, useExternalStoreRuntime } from "@assistant-ui/react";
import type { PiMessage } from "./projection.ts";
import type { PiSession } from "./usePiSession.ts";

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

export function useSessionRuntime(session: PiSession) {
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
  });
}
