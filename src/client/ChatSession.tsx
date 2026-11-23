import { AssistantRuntimeProvider, useAuiState } from "@assistant-ui/react";
import { MenuIcon } from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState, useSyncExternalStore } from "react";
import { ROOT_CONVERSATION_ID } from "../protocol.ts";
import type { ConversationSnapshot } from "./session-state.ts";
import { ActivityPanel } from "./ActivityPanel.tsx";
import { Button } from "./components/ui/button.tsx";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "./components/ui/sheet.tsx";
import { ControlPanel } from "./ControlPanel.tsx";
import { ConversationList } from "./ConversationList.tsx";
import { Thread } from "./Thread.tsx";
import { cn } from "./lib/utils.ts";
import { type PiSession, usePiSession } from "./usePiSession.ts";
import { conversationLabel, useSessionRuntime } from "./useSessionRuntime.ts";

interface ChatSessionProps {
  readonly sessionId: string;
  readonly username: string;
}

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

const wideQuery = "(width >= 48rem)";

const subscribeWide = (onChange: () => void): (() => void) => {
  const query = window.matchMedia(wideQuery);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
};

const isWide = (): boolean => window.matchMedia(wideQuery).matches;

export function ChatSession({ sessionId, username }: ChatSessionProps) {
  const [initialConversationId] = useState(conversationIdFromLocation);
  const session = usePiSession(sessionId, username, initialConversationId);
  const wide = useSyncExternalStore(subscribeWide, isWide);
  const [menuOpen, setMenuOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const activityToggleRef = useRef<HTMLButtonElement | null>(null);
  const activityCloseRef = useRef<HTMLButtonElement | null>(null);
  const conversationHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const activeConversationId = session.activeConversationId;
  const activeConversation = session.activeConversation;
  const activeSummary = session.conversations.find(({ id }) => id === activeConversationId);
  const activityCount = Object.keys(session.activity?.tasks ?? {}).length;
  const isConnected = session.status === "connected";

  const openConversation = (conversationId: number): void => {
    setMenuOpen(false);
    if (conversationId !== session.activeConversationId) session.openConversation(conversationId);
  };
  const runtime = useSessionRuntime(session, openConversation);

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
    if (activeConversationId === undefined) return;
    const linked = conversationIdFromLocation() ?? ROOT_CONVERSATION_ID;
    if (linked !== activeConversationId) {
      window.history.pushState(null, "", `?conversation=${activeConversationId}`);
    }
  }, [activeConversationId]);

  useEffect(() => {
    const handlePopState = (): void => openLinkedConversation();
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

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

  const sidebar = (
    <>
      <header className="flex flex-col gap-1 p-4">
        <a className="text-muted-foreground text-sm" href="/">
          pi-durable-replay
        </a>
        <h1>Session</h1>
        <p className="text-muted-foreground text-sm">
          Joining as <strong className="text-foreground font-medium">{username}</strong>
        </p>
        <p className="text-sm" role="status">
          {statusLabel[session.status]}
        </p>
      </header>

      {session.error === undefined ? null : (
        <p className="text-destructive px-4 pb-4 text-sm" role="alert">
          {session.error}
        </p>
      )}

      <ConversationList disabled={!isConnected} />

      <ControlPanel
        control={session.control}
        usage={activeConversation?.usage}
        activeConversationId={activeConversationId}
        onSetBudgets={session.setBudgets}
        onAbortConversation={session.abortConversation}
        onAbortSession={session.abortSession}
        onInjectFault={session.injectFault}
      />
    </>
  );

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <TypingPresence session={session} />
      <Sheet open={menuOpen && !wide} onOpenChange={setMenuOpen}>
        <div
          className={cn(
            "grid h-dvh grid-rows-[minmax(0,1fr)] overflow-hidden md:grid-cols-[16rem_minmax(0,1fr)]",
            activityOpen && "min-[75rem]:grid-cols-[16rem_minmax(32rem,1fr)_minmax(18rem,24rem)]",
          )}
        >
          {wide ? (
            <aside className="flex min-h-0 flex-col overflow-y-auto overscroll-contain border-e">
              {sidebar}
            </aside>
          ) : (
            <SheetContent
              className="overflow-y-auto overscroll-contain"
              aria-describedby={undefined}
            >
              <SheetTitle className="sr-only">Session menu</SheetTitle>
              {sidebar}
            </SheetContent>
          )}

          <main
            className={cn(
              "grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden",
              activityOpen && "hidden min-[75rem]:grid",
            )}
          >
            <header className="border-b p-4">
              <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                <div className="flex min-w-0 items-center gap-2">
                  {wide ? null : (
                    <SheetTrigger asChild>
                      <Button variant="ghost" size="icon" className="size-11 shrink-0">
                        <MenuIcon aria-hidden />
                        <span className="sr-only">Open session menu</span>
                      </Button>
                    </SheetTrigger>
                  )}
                  <h2
                    ref={conversationHeadingRef}
                    id="transcript-heading"
                    tabIndex={-1}
                    className="min-w-0 truncate"
                  >
                    {activeSummary === undefined
                      ? "Conversation"
                      : conversationLabel(activeSummary)}
                  </h2>
                </div>
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
            className={
              activityOpen
                ? "grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden min-[75rem]:border-s"
                : "hidden"
            }
            graph={session.activity}
            activeConversationId={activeConversationId}
            onAbortTask={session.abortTask}
            onClose={closeActivity}
            closeButtonRef={activityCloseRef}
            onOpenConversation={(conversationId) => {
              openConversation(conversationId);
              if (compactActivityLayout()) {
                setActivityOpen(false);
                requestAnimationFrame(() => conversationHeadingRef.current?.focus());
              }
            }}
          />
        </div>
      </Sheet>
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
    <section className="text-muted-foreground mt-1 text-xs" aria-label="Runtime information">
      <dl className="flex flex-col gap-1">
        <div className="flex flex-wrap gap-x-2 gap-y-1">
          <RuntimeDatum label="Model" value={model} />
          <RuntimeDatum label="Thinking" value={agent?.thinkingLevel ?? "off"} />
          <RuntimeDatum label="Tokens" value={totals.tokens.toLocaleString()} />
          <RuntimeDatum label="Cost" value={formatCost(totals.cost)} />
        </div>
        <div className="flex min-w-0 gap-1">
          <dt>Tools:</dt>
          <dd className="[overflow-wrap:anywhere]">{tools}</dd>
        </div>
      </dl>
    </section>
  );
}

function RuntimeDatum({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="flex min-w-0 gap-1">
      <dt>{label}:</dt>
      <dd className="[overflow-wrap:anywhere]">{value}</dd>
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
