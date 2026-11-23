import { AssistantRuntimeProvider, useAuiState } from "@assistant-ui/react";
import { type MouseEvent, useEffect, useEffectEvent, useRef, useState } from "react";
import { type ConversationSummary, ROOT_CONVERSATION_ID } from "../protocol.ts";
import type { ConversationSnapshot } from "./session-state.ts";
import { ActivityPanel } from "./ActivityPanel.tsx";
import { Button } from "./components/ui/button.tsx";
import { ControlPanel } from "./ControlPanel.tsx";
import { Thread } from "./Thread.tsx";
import { type PiSession, usePiSession } from "./usePiSession.ts";
import { useSessionRuntime } from "./useSessionRuntime.ts";

interface ChatSessionProps {
  readonly sessionId: string;
  readonly username: string;
}

const conversationLabel = ({ id, parent, owner }: ConversationSummary): string => {
  if (id === ROOT_CONVERSATION_ID) return `Main conversation (id: ${id})`;
  if (owner !== undefined) return `Subagent (id: ${id}, owner: ${owner.conversationId})`;
  if (parent !== undefined) return `Fork (id: ${id}, from: ${parent.at})`;
  return `Conversation (id: ${id})`;
};

const statusLabel = {
  connecting: "Connecting",
  connected: "Connected",
  failed: "Connection failed",
} as const;

const TYPING_IDLE_MS = 1_500;

const conversationIdFromLocation = (): number | undefined => {
  const value = new URLSearchParams(window.location.search).get("conversation");
  if (value === null || !/^\d+$/.test(value)) return undefined;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
};

export function ChatSession({ sessionId, username }: ChatSessionProps) {
  const [initialConversationId] = useState(conversationIdFromLocation);
  const session = usePiSession(sessionId, username, initialConversationId);
  const runtime = useSessionRuntime(session);
  const [activityOpen, setActivityOpen] = useState(false);
  const activityToggleRef = useRef<HTMLButtonElement | null>(null);
  const activityCloseRef = useRef<HTMLButtonElement | null>(null);
  const conversationHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const activeConversationId = session.activeConversationId;
  const activeConversation = session.activeConversation;
  const activeSummary = session.conversations.find(({ id }) => id === activeConversationId);
  const activityCount = Object.keys(session.activity?.tasks ?? {}).length;
  const isConnected = session.status === "connected";

  const openLinkedConversation = useEffectEvent(() => {
    const conversationId = conversationIdFromLocation() ?? ROOT_CONVERSATION_ID;
    if (
      conversationId !== activeConversationId &&
      session.conversations.some(({ id }) => id === conversationId)
    ) {
      session.openConversation(conversationId);
    }
  });

  useEffect(() => {
    const handlePopState = (): void => openLinkedConversation();
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  const followConversationLink = (
    event: MouseEvent<HTMLAnchorElement>,
    conversationId: number,
  ): void => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    event.preventDefault();
    if (conversationId !== session.activeConversationId) {
      window.history.pushState(null, "", event.currentTarget.href);
      session.openConversation(conversationId);
    }
  };

  const compactActivityLayout = (): boolean => window.matchMedia("(width < 75rem)").matches;

  const toggleActivity = (): void => {
    const opening = !activityOpen;
    setActivityOpen(opening);
    if (opening && compactActivityLayout()) {
      requestAnimationFrame(() => activityCloseRef.current?.focus());
    }
  };

  const closeActivity = (): void => {
    setActivityOpen(false);
    requestAnimationFrame(() => activityToggleRef.current?.focus());
  };

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <TypingPresence session={session} />
      <div
        className={`session-workspace${activityOpen ? " session-workspace--activity-open" : ""}`}
      >
        <aside className="session-sidebar">
          <header className="session-header flex flex-col gap-1">
            <a className="text-muted-foreground text-sm" href="/">
              pi-durable-replay
            </a>
            <h1>Session</h1>
            <p className="text-muted-foreground text-sm">
              Joining as <strong className="text-foreground font-medium">{username}</strong>
            </p>
            <p className="connection-status text-sm" role="status">
              {statusLabel[session.status]}
            </p>
          </header>

          {session.error === undefined ? null : (
            <p className="session-error text-destructive text-sm" role="alert">
              {session.error}
            </p>
          )}

          <nav className="conversation-navigation" aria-labelledby="conversations-heading">
            <div className="conversation-navigation-header flex flex-col gap-2">
              <h2 id="conversations-heading">Conversations</h2>
              <Button
                variant="outline"
                size="sm"
                onClick={session.createConversation}
                disabled={!isConnected}
              >
                New conversation
              </Button>
            </div>
            <div className="conversation-list" tabIndex={0}>
              {session.conversations.length === 0 ? (
                <p className="text-muted-foreground text-sm">No conversations yet.</p>
              ) : (
                <ul className="flex flex-col gap-0.5">
                  {session.conversations.map((conversation) => (
                    <li key={conversation.id}>
                      <a
                        className="hover:bg-accent aria-[current=page]:bg-accent block rounded-md px-2 py-1.5 text-sm no-underline aria-[current=page]:font-medium"
                        href={`?conversation=${conversation.id}`}
                        aria-current={conversation.id === activeConversationId ? "page" : undefined}
                        onClick={(event) => followConversationLink(event, conversation.id)}
                      >
                        {conversationLabel(conversation)}
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </nav>

          <ControlPanel
            control={session.control}
            usage={activeConversation?.usage}
            activeConversationId={activeConversationId}
            onSetBudgets={session.setBudgets}
            onAbortConversation={session.abortConversation}
            onAbortSession={session.abortSession}
            onApproveUnsafe={session.approveUnsafe}
            onInjectFault={session.injectFault}
          />
        </aside>

        <main className="conversation-view">
          <header className="conversation-header">
            <div className="conversation-titlebar">
              <h2 ref={conversationHeadingRef} id="transcript-heading" tabIndex={-1}>
                {activeSummary === undefined ? "Conversation" : conversationLabel(activeSummary)}
              </h2>
              <Button
                ref={activityToggleRef}
                variant="outline"
                className="min-h-11"
                aria-controls="activity-panel"
                aria-expanded={activityOpen}
                onClick={toggleActivity}
              >
                Activity{" "}
                <span
                  aria-hidden="true"
                  className="bg-background inline-grid min-w-6 place-items-center rounded-full px-1.5 text-xs tabular-nums"
                >
                  {activityCount}
                </span>
              </Button>
            </div>
            {activeConversation === undefined ? null : (
              <ConversationDetails conversation={activeConversation} />
            )}
          </header>

          <Thread
            conversation={activeConversation}
            onFork={(entryId) => {
              if (activeConversationId !== undefined) {
                session.forkConversation(activeConversationId, entryId);
              }
            }}
            onReplay={(entryId) => {
              if (activeConversationId !== undefined) {
                session.replayFork(activeConversationId, entryId);
              }
            }}
            onFillGap={(gap) => {
              if (activeConversationId !== undefined) session.fillGap(activeConversationId, gap);
            }}
          />
        </main>

        <ActivityPanel
          graph={session.activity}
          activeConversationId={activeConversationId}
          onAbortTask={session.abortTask}
          onClose={closeActivity}
          closeButtonRef={activityCloseRef}
          onOpenConversation={(conversationId) => {
            if (conversationId !== session.activeConversationId) {
              window.history.pushState(null, "", `?conversation=${conversationId}`);
              session.openConversation(conversationId);
            }
            if (compactActivityLayout()) {
              setActivityOpen(false);
              requestAnimationFrame(() => conversationHeadingRef.current?.focus());
            }
          }}
        />
      </div>
    </AssistantRuntimeProvider>
  );
}

function TypingPresence({ session }: { readonly session: PiSession }) {
  const text = useAuiState((s) => s.composer.text);
  const conversationId = session.status === "connected" ? session.activeConversationId : undefined;
  const typingRef = useRef<number | undefined>(undefined);
  const { setTyping } = session;

  useEffect(() => {
    if (conversationId === undefined || text.length === 0) return;
    typingRef.current = conversationId;
    setTyping(conversationId, true);
    const idle = setTimeout(() => {
      typingRef.current = undefined;
      setTyping(conversationId, false);
    }, TYPING_IDLE_MS);
    return () => clearTimeout(idle);
  }, [conversationId, text, setTyping]);

  useEffect(() => {
    if (text.length > 0 && typingRef.current === conversationId) return;
    const typing = typingRef.current;
    if (typing === undefined) return;
    typingRef.current = undefined;
    setTyping(typing, false);
  }, [conversationId, text, setTyping]);

  return null;
}

function ConversationDetails({ conversation }: { readonly conversation: ConversationSnapshot }) {
  const agent = conversation.agent;
  const totals = usageTotals(conversation.usage);
  const model =
    agent?.model === undefined
      ? "Provider default"
      : `${agent.model.provider}/${agent.model.modelId}`;
  const tools =
    agent?.tools === undefined
      ? "Host default"
      : Array.isArray(agent.tools)
        ? agent.tools.length === 0
          ? "None"
          : agent.tools.join(", ")
        : `Host default except ${agent.tools.remove.join(", ")}`;

  return (
    <section
      className="runtime-information text-muted-foreground mt-1 text-xs"
      aria-label="Runtime information"
    >
      <dl>
        <div className="runtime-primary">
          <RuntimeDatum label="Model" value={model} />
          <RuntimeDatum label="Thinking" value={agent?.thinkingLevel ?? "off"} />
          <RuntimeDatum label="Tokens" value={totals.tokens.toLocaleString()} />
          <RuntimeDatum label="Cost" value={formatCost(totals.cost)} />
        </div>
        <div className="runtime-tools">
          <dt>Tools:</dt>
          <dd>{tools}</dd>
        </div>
      </dl>
    </section>
  );
}

function RuntimeDatum({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div>
      <dt>{label}:</dt>
      <dd>{value}</dd>
    </div>
  );
}

function usageTotals(usage: ConversationSnapshot["usage"]): { tokens: number; cost: number } {
  let tokens = 0;
  let cost = 0;
  for (const bucket of [usage?.models ?? {}, usage?.tools ?? {}]) {
    for (const value of Object.values(bucket)) {
      tokens += value.totalTokens;
      cost += value.cost.total;
    }
  }
  return { tokens, cost };
}

const costFormatter = new Intl.NumberFormat(undefined, {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 6,
});

const formatCost = (cost: number): string => costFormatter.format(cost);
