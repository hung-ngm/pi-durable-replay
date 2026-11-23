# Plan: move the client to assistant-ui

Status: PR1 to PR4 landed and deployed on 24 Nov 2026. The restyle units R1 to R4 and the revised PR5 to PR7 were approved on 24 Nov 2026.

## What changes

The transcript, composer, message actions, tool cards, and conversation list move to [assistant-ui](https://www.assistant-ui.com/docs). Its `useExternalStoreRuntime` runs over the reducer that `usePiSession` already keeps, so the Durable Object stays the only source of truth. Every message on screen is still a projection of committed state plus `pi.live`.

Two bugs land first, on the current UI:

- Plain Enter does not send a prompt. [ChatSession.tsx:215](../../src/client/ChatSession.tsx) submits only on Cmd or Ctrl+Enter, and plain Enter inserts a newline.
- Sign-in cannot finish in browsers without `window.prompt()`. [control-token.ts:20](../../src/client/control-token.ts) asks for the token only through `prompt()`. The Claude browser pane shows "prompt() is not supported." and stays at 401. Embedded webviews behave the same way.

The **Activity** panel (task graph, kills) and the **Control** panel (budgets, Ledger, faults, replay provenance) have no assistant-ui counterpart. assistant-ui is a chat UI kit, and these are operator dashboards. They stay plain React inside the `AssistantRuntimeProvider` and keep reading `usePiSession`. "All our UI on assistant-ui" means every chat surface. The dashboards share its styles and its provider.

## Research basis

The full notes are in the session scratchpad report `assistant-ui-research.md`. Each claim there is labelled as checked against source, docs, or a TypeScript compile, or as inferred. These are the ones this plan rests on:

| Fact                                                                                                                                                                                                               | Version                                          | How it was checked                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ | --------------------------------------------------- |
| `@assistant-ui/react` peers React 18 or 19, and Vite needs no plugin                                                                                                                                               | 0.15.38                                          | package source                                      |
| `useExternalStoreRuntime` is the only runtime that lets server-pushed state drive the thread. LocalRuntime owns its own messages. AssistantTransport sends each command as an HTTP POST and has no WebSocket mode. | 0.15.38                                          | package source                                      |
| `ComposerPrimitive.Input` `submitMode` defaults to `"enter"`, with Shift+Enter for a newline                                                                                                                       | 0.15.38                                          | `ComposerInput.d.ts`                                |
| `ThreadPrimitive.Viewport` has `autoScroll`, `turnAnchor`, and `scrollToBottomOnRunStart`                                                                                                                          | 0.15.38                                          | `ThreadViewport.d.ts`                               |
| `assistant-ui init` runs `shadcn init` and adds Tailwind. The unstyled primitives need neither. `@assistant-ui/styles` is stale and `react-ui` is deprecated.                                                      | CLI 0.0.136                                      | package source, npm                                 |
| A community Pi Durable adapter exists. Its `projection.ts` (MIT, 184 lines) maps `TranscriptView` and `pi.live` onto `ThreadMessageLike`.                                                                          | `@usecontextlayer/pi-durable-assistant-ui` 2.2.0 | read in full                                        |
| That adapter cannot be installed here. It pins pi-ai and chord 1.5.0 (this repo uses 1.6.0) and expects an HTTP/SSE host.                                                                                          | 2.2.0                                            | its `package.json`                                  |
| Tool UIs register through `defineToolkit` plus `Tools({ toolkit })`. `makeAssistantToolUI` is deprecated.                                                                                                          | 0.15.38                                          | TypeScript compile                                  |
| A tool-call part can carry `approval`, and the user's answer reaches `onRespondToToolApproval`                                                                                                                     | 0.15.38                                          | TypeScript compile                                  |
| The library adds about 162 KB gzip over React DOM                                                                                                                                                                  | 0.15.38                                          | esbuild measurement, not yet measured in this build |

## Install and setup

Don't run `assistant-ui init`. It brings in shadcn and Tailwind, and it exits with code 2 when an agent runs it. Install the packages directly:

```bash
bun add @assistant-ui/react@0.15.38 @assistant-ui/react-markdown@0.14.26
```

Styling moved to Tailwind v4 and copied shadcn components in [ADR 0006](../adr/0006-client-styling-on-tailwind-and-shadcn.md); see **Restyle** below. Syntax highlighting stays out. No transcript today needs it, and it is the largest optional dependency.

## Data shape

Settle this first, because every component reads it.

```ts
// src/client/projection.ts, ported from the Pi Durable adapter (MIT notice kept)
type PiMessage = ThreadMessageLike & {
  readonly id:
    | `entry:${number}:${number | "notice"}` // committed
    | `generation:${number}` // live answer, per task
    | `tool:${string}` // live tool slot with no committed request
    | `failure:${number}`; // run failure banner
  readonly metadata: {
    readonly custom: {
      readonly conversationId: number;
      readonly entryId?: number; // present on committed messages: Fork and Replay read it
      readonly taskId?: number; // present on live messages: Stop reads it
    };
  };
};

interface ConversationSnapshot {
  // replaces today's TranscriptEntry[] flattening
  readonly id: number;
  readonly messages: readonly PiMessage[]; // projection output, identity-stable per id
  readonly isRunning: boolean; // pi.live.run is foreground
  readonly runTaskId?: number; // what Stop aborts (scope "run")
  readonly hasEarlier: boolean;
  readonly gaps: readonly TranscriptGap[]; // rendered as data parts `pi-gap`
  readonly queued: readonly QueuedInput[]; // rendered in the viewport footer, not as messages
  readonly typing: readonly string[];
  readonly agent?: AgentState;
  readonly usage?: UsageState;
}
```

How this departs from the adapter:

- **Identity is stable per id.** After each projection, a message whose id and content match the previous projection reuses the previous object. assistant-ui caches converted messages by object identity, so without this every streamed token re-renders the whole transcript.
- **Gaps become messages.** A mid-transcript gap becomes an assistant message with one data part, `{ type: "data", name: "pi-gap", data: gap }`. It renders a "Load missing messages" button that calls `fillGap`.
- **Queued inputs stay out of `messages`.** With `isRunning` true and a user message last, the runtime inserts its own "running" placeholder. Queued inputs therefore render in `ThreadPrimitive.ViewportFooter`.
- **The unsafe approval rides on the tool part.** A `charge_credits` tool-call part gets `approval: { id: "replay:<conversationId>", approved }` when its conversation is a Fork Replay whose `pendingUnsafeApproval` was set. That state comes from `ControlView.replays` in the session snapshot.

## Runtime wiring

`src/client/useSessionRuntime.ts` is one hook. It calls `useExternalStoreRuntime` with:

| Field                         | Source                                                                                                                                                                               |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `messages`                    | `activeConversation.messages`, with `convertMessage` a module-level identity                                                                                                         |
| `isRunning`, `isDisabled`     | `snapshot.isRunning`, and `status !== "connected"`                                                                                                                                   |
| `onNew(message)`              | `submitPrompt(conversationId, text)`. It rejects non-text parts at this boundary.                                                                                                    |
| `onCancel()`                  | `abortTask(runTaskId, "run")`, a run-scope Kill from the composer's Stop button                                                                                                      |
| `hasEarlier`, `onLoadEarlier` | `snapshot.hasEarlier`, `loadEarlier(conversationId)`                                                                                                                                 |
| `onRespondToToolApproval`     | `approveUnsafe(conversationId)` when `approved`                                                                                                                                      |
| `adapters.threadList`         | `conversations` mapped to `{ id: String(id), title: conversationLabel(c) }`. `onSwitchToThread` opens a conversation and pushes `?conversation=`. `onSwitchToNewThread` creates one. |

`onEdit`, `onReload`, and `setMessages` stay unset. Pi Durable has no edit or regenerate command, and a fork is a new conversation, not a branch. Leaving them unset hides the Edit, Reload, and BranchPicker controls.

## Landing order and dependencies

```
PR1 sign-in form ─┐
PR2 Enter sends ──┤  (landed)
PR3 projection ───┤
PR4 thread ───────┘──> R1 Tailwind foundation ──> R2 thread and composer ──> R3 tool rows and pi parts ──> R4 dashboards
                                                                                                          │
                       PR5 thread list sidebar <──────────────────────────────────────────────────────────┘
                         └──> PR6 tool UIs + inline approval ──> PR7 markdown, docs, delete styles.css
```

| PR  | Depends on | Files it may touch                                                                                                                                                                                                               | Operator review before merge |
| --- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| PR1 | trunk      | `src/client/control-token.ts`, `src/client/App.tsx`, `src/client/styles.css`                                                                                                                                                     | yes (interaction)            |
| PR2 | trunk      | `src/client/ChatSession.tsx`                                                                                                                                                                                                     | yes (interaction)            |
| PR3 | trunk      | `package.json`, `bun.lock`, `src/client/projection.ts`, `src/client/session-state.ts`, `test/projection.test.ts`, `test/session-state.test.ts`, `docs/adr/0005-*.md`, `SPEC.md`                                                  | no                           |
| PR4 | PR3        | `src/client/ChatSession.tsx`, `src/client/Thread.tsx` (new), `src/client/useSessionRuntime.ts` (new), `src/client/styles.css`; deletes `src/client/Transcript.tsx`, `test/transcript.test.tsx`                                   | yes                          |
| R1  | PR4        | `package.json`, `bun.lock`, `vite.config.ts`, `tsconfig.client.json`, `src/client/main.tsx`, `src/client/globals.css` (new), `src/client/lib/` (new), `src/client/components/` (new), `docs/adr/0005-*.md`, `docs/adr/0006-*.md` | no (lands on main)           |
| R2  | R1         | `src/client/Thread.tsx`, `src/client/ChatSession.tsx`, `src/client/styles.css`                                                                                                                                                   | no (lands on main)           |
| R3  | R2         | `src/client/components/assistant-ui/` (new files), `src/client/Thread.tsx`, `src/client/styles.css`                                                                                                                              | no (lands on main)           |
| R4  | R3         | `src/client/App.tsx`, `src/client/ChatSession.tsx`, `src/client/ControlPanel.tsx`, `src/client/ActivityPanel.tsx`, `src/client/styles.css`                                                                                       | no (lands on main)           |
| PR5 | R4         | `src/client/ChatSession.tsx`, `src/client/ConversationList.tsx` (new), `src/client/useSessionRuntime.ts`, `styles.css`                                                                                                           | yes                          |
| PR6 | PR5        | `src/client/tools/*.tsx` (new), `src/client/projection.ts`, `src/client/ControlPanel.tsx`, `src/replay.ts` (message text only), `styles.css`                                                                                     | yes                          |
| PR7 | PR6        | `src/client/Thread.tsx`, `package.json`, `README.md`, `SPEC.md`, `styles.css`                                                                                                                                                    | no                           |

Every unit lands in order, straight on `main`: commit, push, the deploy workflow, then a check on the deployed app (see **Restyle: How each unit is verified and shipped**). R1 to PR7 all touch the client styles, so none run in parallel.

Perf baseline, measured on trunk `d0d6233` on 23 Nov 2026 with `bun run build`: client JS is 284,560 bytes raw and 87,175 bytes gzip (`gzip -c | wc -c`), and CSS is 6,570 bytes raw and 1,706 bytes gzip. Every perf box below uses that probe.

---

## PR1. Sign in with an in-page form

**Why.** Sign-in calls `window.prompt()`, which the Claude browser pane and many webviews don't support. The operator can't open a session there, and no browser-driven check can run.

- [ ] Depends on: trunk.
- [ ] Files: `src/client/control-token.ts`, `src/client/App.tsx`, `src/client/styles.css`.
- [ ] Change: `SignedIn` and the landing page render a password field and a **Sign in** button. Submitting posts `{ token }` to `POST /api/auth`. A 401 shows "That control token was wrong." inline and keeps focus in the field. `ensureSignedIn()` becomes `isSignedIn()` (the `GET /api/auth` probe) plus `signIn(token)`. `window.prompt` is deleted.
- [ ] Result you see: a token field instead of a browser dialog. A wrong token shows an inline error. A right one opens the session, and other tabs skip the form.
- [ ] Unit: `test/auth.test.ts` still passes. The Worker contract does not change.
- [ ] Live: in the Claude browser pane, open `/sessions/<id>`, submit a wrong token, then the token from `.dev.vars`. Passes when the wrong token shows the inline error, the right one renders the session, and a second tab opens without the form.
- [ ] Perf: client JS gzip stays within +1 KB of 87,175 bytes.

## PR2. Plain Enter sends the prompt

**Why.** The operator expects Enter to send, as in every chat UI. Today only Cmd or Ctrl+Enter sends.

- [ ] Depends on: trunk. Its live check needs PR1 merged, or the operator's own browser.
- [ ] Files: `src/client/ChatSession.tsx`.
- [ ] Change: `submitWithKeyboardShortcut` submits on Enter with no Shift, Alt, or modifier, and skips the key while `nativeEvent.isComposing` is true (an IME is composing). Shift+Enter inserts a newline. `aria-keyshortcuts` becomes `"Enter"`, and the placeholder says "Send a message… (Shift+Enter for a new line)".
- [ ] Result you see: Enter sends. Shift+Enter adds a line. Typing Vietnamese or Japanese with an IME does not send mid-composition.
- [ ] Unit: none useful. The repo's client tests render static markup and can't press keys. The live box is the proof.
- [ ] Live: in a session, type "hello" and press Enter. Passes when the prompt appears in the transcript and the textarea clears. Then type "a", press Shift+Enter, type "b", and check that the textarea holds "a\nb" with nothing sent.
- [ ] Perf: client JS gzip within +1 KB of baseline.
- [ ] Note: PR4 replaces this textarea with `ComposerPrimitive.Input`, whose default `submitMode="enter"` keeps the same behavior. PR4's live box repeats this check.

## PR3. Projection, dependency, and ADR 0005

**Why.** SPEC says the client is "kept and extended. No redesign." Moving to assistant-ui reverses that, so an ADR records the decision and SPEC points to it. The projection is the hard part, and it is a pure function, so it lands first with tests and no UI change.

- [ ] Depends on: trunk.
- [ ] Files: `package.json`, `bun.lock`, `src/client/projection.ts`, `src/client/session-state.ts`, `test/projection.test.ts`, `test/session-state.test.ts`, `docs/adr/0005-client-on-assistant-ui.md`, `SPEC.md` (Client bullet only).
- [ ] Change: `bun add` both packages at pinned versions. Port the adapter's `projection.ts` with its MIT notice, adapted to pi-ai and chord 1.6.0 types, plus the four departures in **Data shape**. `ConversationSnapshot` gains `messages`, `isRunning`, `runTaskId`, and `hasEarlier`. The old fields that PR4 deletes stay for one PR, the only intermediate state this plan allows.
- [ ] Result you see: nothing in the UI. `bun run check` and `bun run test` pass.
- [ ] Unit (behavior of the projection, given `TranscriptView` fixtures):
  - [ ] A tool result joins its call by `callId` into one tool-call part with `result` and `isError`.
  - [ ] A live generation projects as one `generation:<taskId>` message with status `running`, and disappears once its entry commits.
  - [ ] Re-projecting an unchanged view returns the same message objects (`toBe`), and a streamed token changes only the live message's identity.
  - [ ] A gap becomes a `pi-gap` data part after the entry it follows.
  - [ ] A `charge_credits` call in a pending Fork Replay carries `approval.approved === false`, and `true` after approval.
  - [ ] Aborted runs project as `incomplete` and `cancelled`, so no tool card shows "awaiting action".
- [ ] Live: none. No UI changes.
- [ ] Perf: client JS gzip within +2 KB of baseline. The packages are installed but not imported yet, so tree-shaking should drop them. A bigger delta means something imports them early.

## PR4. Transcript and composer on assistant-ui

**Why.** This is the migration itself. The transcript, composer, Stop, Fork, and Replay render through assistant-ui primitives, and about 560 lines of hand-rolled transcript, auto-scroll, and draft code go away.

- [ ] Depends on: PR3.
- [ ] Files: new `src/client/useSessionRuntime.ts` and `src/client/Thread.tsx`; `src/client/ChatSession.tsx`, `src/client/styles.css`. Deletes `src/client/Transcript.tsx` and `test/transcript.test.tsx`, plus the `TranscriptEntry` fields left from PR3.
- [ ] Change:
  - [ ] `ChatSession` wraps the workspace in `AssistantRuntimeProvider` with the runtime from `useSessionRuntime`.
  - [ ] `Thread.tsx` holds `ThreadPrimitive.Root` and `Viewport` (`autoScroll`, `turnAnchor="bottom"`). It replaces the hand-rolled rAF scroll and its eight refs. It also holds `ThreadPrimitive.Messages`, `ThreadPrimitive.LoadEarlier`, and `ViewportFooter` with the queued inputs and the compaction status.
  - [ ] Messages render `MessagePrimitive.Parts`. Text renders through `MessageText` until PR7. Data part `pi-gap` renders the "Load missing messages" button, and `pi-context` renders compaction and reset summaries. Tool-call parts render `ToolCard`, a port of today's `ToolExecution` with status from the part and the message.
  - [ ] `ActionBarPrimitive.Root` holds **Fork** on user and assistant messages and **Replay** on assistant messages that contain tool calls. Both read `entryId` through `useAuiState((s) => s.message.metadata.custom.entryId)`.
  - [ ] Run failures render through `MessagePrimitive.Error` on the `failure:<taskId>` message.
  - [ ] The composer is `ComposerPrimitive.Root`, `Input` (`maxLength={MAX_PROMPT_CHARACTERS}`, `submitMode="enter"`), `Send`, and `Cancel` labelled **Stop run**. Typing presence reads `useAuiState((s) => s.composer.text)` in one effect with the existing 1.5 s idle timeout.
- [ ] Result you see: the same transcript with Fork, Replay, tool cards, gaps, queued inputs, compaction notes, and failure banners. Stop sits next to Send while a run is live. Scrolling follows the stream unless you scroll up.
- [ ] Unit: projection tests from PR3 pass. `test/session-state.test.ts` is updated to assert `messages` and no longer the deleted fields. `bun run check` passes.
- [ ] Live, in the browser pane with the corpus backend:
  - [ ] Ask "Research the costs of solar panels". Passes when the three research subagents' tool cards show Running, then Completed, the answer streams in, and the viewport stays at the bottom.
  - [ ] Scroll up mid-stream. Passes when the viewport stays where you put it.
  - [ ] Press Enter on "hello". It sends. Shift+Enter adds a newline. (Repeats PR2's check.)
  - [ ] Click **Stop run** during `slow_search`. Passes when the run ends as killed, the tool card shows cancelled, and the Control panel's last kill reads `run (manual)`.
  - [ ] Click **Fork** on a user message. Passes when a new conversation opens with history up to that entry.
  - [ ] Click **Replay** on an assistant message with tool calls. Passes when a Fork Replay opens and the Control panel lists the carried tool results.
  - [ ] Evict the object from the Control panel mid-run. Passes when the thread reconnects, resumes, and answers with no duplicated messages.
- [ ] Perf:
  - [ ] Client JS gzip ≤ 255,000 bytes, the 87,175-byte baseline plus the ~162 KB estimate with margin. Fails above that.
  - [ ] Streaming: in the pane, a `PerformanceObserver({ type: "longtask" })` counts tasks over 50 ms while a 40-message transcript streams one answer. Measure trunk first. Fails if PR4 exceeds trunk's count by more than 2.

## Restyle: the Generative UI look

**Why.** The chat should look like assistant-ui's [Generative UI example](https://www.assistant-ui.com/examples/generative-ui) ([source](https://github.com/assistant-ui/assistant-ui/tree/main/examples/with-generative-ui)). PR4 left the primitives unstyled under browser defaults. [ADR 0006](../adr/0006-client-styling-on-tailwind-and-shadcn.md) records the switch to Tailwind v4 and copied shadcn components.

### Decisions (grilled 24 Nov 2026)

| Decision         | Choice                                                                                                                                                                                                                                                                                                                      |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Styling          | Tailwind v4 via `@tailwindcss/vite`, `tw-animate-css`, shadcn zinc tokens in oklch, components copied as source in their Radix variants. No shadcn CLI.                                                                                                                                                                     |
| Scope            | The whole page takes the tokens and buttons. Only the thread and composer copy the example's layout. The Activity and Control panels keep their structure.                                                                                                                                                                  |
| Unchanged        | Runtime (`useSessionRuntime`), projection, message ids.                                                                                                                                                                                                                                                                     |
| Scroll           | `turnAnchor="bottom"` with auto-scroll, plus the example's scroll-to-bottom button.                                                                                                                                                                                                                                         |
| Dropped controls | Edit, Reload, branch picker, feedback, Export as Markdown, welcome suggestions. Fork and Replay sit in the action bar.                                                                                                                                                                                                      |
| Action bar       | `autohide="not-last"`: shown on hover or focus, always on the last message.                                                                                                                                                                                                                                                 |
| Kill button      | The composer's button reads **Kill run**, the glossary's term for a run-scope Kill. "Stop" stays out, as the glossary says.                                                                                                                                                                                                 |
| Theme            | Follows `prefers-color-scheme`. No toggle. System fonts.                                                                                                                                                                                                                                                                    |
| Tool calls       | The example's collapsible row: status icon, "Used tool: **name**", chevron, args and result in muted blocks. Consecutive calls group under "N tool calls". Running and failed rows start open. Diagnostics go in the body.                                                                                                  |
| Pi parts         | Run failure: destructive error box with `TriangleAlert`. Compaction and reset: muted centred divider that expands. Gap: centred outline button. Queued inputs: muted right-aligned bubbles with a "Queued" badge. Typing and compaction status: muted text in the composer footer. Retry notice: muted line with a spinner. |
| Phone            | R4 restyles today's responsive layout in place. PR5 brings the example's off-canvas sidebar.                                                                                                                                                                                                                                |
| Budget           | Client JS stays ≤ 280,000 bytes gzip; 300,000 is a hard stop that needs the operator's sign-off. Client CSS ≤ 15,000 bytes gzip.                                                                                                                                                                                            |

### Accessibility bar, checked in every unit

- Every role and label that exists today survives: `role="log"` on the transcript, the `#prompt` label, the sign-in field's label and alert, the Control and Activity panel controls.
- Every icon-only button has an accessible name (`TooltipIconButton` renders an `sr-only` label).
- Focus is visible on every control, the composer shell included (`focus-within` border, since the textarea has no outline).
- Every entrance and collapse animation has a `motion-reduce` guard, the message entrances included.
- Proof: the `read_page` accessibility tree plus a keyboard tab-through in the browser pane, before and after.

### How each unit is verified and shipped

1. **Local gate.** On the `verify` launch config (corpus backend): the unit's live box, the accessibility bar, and screenshots of our thread beside the live example at 1280 and 375 widths, light and dark. Parity is judged by eye against the deliberate differences above, not pixel-diffed. `bun run check` and `bun run test` pass. Stop the verify server before `bun run check`.
2. **Ship.** Commit to `main` and push. The push deploys through `.github/workflows/deploy.yml`.
3. **Deployed smoke.** Once the run is green, on the deployed app: one research prompt, the tool rows, light and dark, a 375-width screenshot. Runs there spend real OpenAI and Exa tokens, so they stay short. The operator signs in once in the pane; the cookie lasts 30 days.

## R1. Tailwind foundation

- [ ] Depends on: PR4.
- [ ] Files: `package.json`, `bun.lock`, `vite.config.ts`, `tsconfig.client.json`, new `src/client/globals.css`, new `src/client/lib/utils.ts`, new `src/client/components/ui/{button,tooltip,collapsible}.tsx`, new `src/client/components/assistant-ui/tooltip-icon-button.tsx`, `src/client/main.tsx`, `docs/adr/0006-*.md`, `docs/adr/0005-*.md` (one line pointing to 0006).
- [ ] Change: add `tailwindcss`, `@tailwindcss/vite`, `tw-animate-css`, `radix-ui`, `class-variance-authority`, `clsx`, `tailwind-merge`, `lucide-react` at exact versions. `globals.css` holds `@import "tailwindcss"`, `tw-animate-css`, the zinc tokens for light and dark under `prefers-color-scheme`, the base layer, and the collapsible and shimmer keyframes from assistant-ui's default template. `@/` resolves to `src/client`. `styles.css` stays imported after `globals.css`, so nothing moves yet.
- [ ] Result you see: the page in the new colours and system font, light or dark with the OS. Layout unchanged.
- [ ] Unit: `bun run check` and `bun run test` pass.
- [ ] Live: the PR4 live box still passes locally (Enter sends, Stop run, Fork, Replay). Dark mode follows the pane's colour scheme. The accessibility bar holds.
- [ ] Perf: JS gzip within +25 KB of PR4's 198,818 bytes (expect less: unused Radix pieces tree-shake). CSS gzip ≤ 15,000. Name both numbers in the commit.

## R2. Thread and composer in the example's layout

- [ ] Depends on: R1.
- [ ] Files: `src/client/Thread.tsx`, `src/client/ChatSession.tsx`, `src/client/styles.css` (delete the transcript and composer rules it replaces).
- [ ] Change: port `thread.aui.tsx`'s layout onto our `Thread`: the 44rem column, user bubbles on the right, assistant text without a bubble, the action bar (`autohide="not-last"`) with Copy, Fork, and Replay as `TooltipIconButton`s, the scroll-to-bottom button, and the composer shell with a round Send (`ArrowUp`) and a round **Kill run** (`Square`) button. Message entrances get `motion-reduce:animate-none`.
- [ ] Result you see: the example's thread and composer, with Fork and Replay in place of Edit, Reload, and feedback.
- [ ] Unit: `bun run check` and `bun run test` pass.
- [ ] Live: a research run streams with the viewport at the bottom; scrolling up holds and shows the scroll-to-bottom button; Enter sends and Shift+Enter adds a line; **Kill run** ends a `slow_search` run with the Control panel reading `run (manual)`; Fork and Replay work after hovering or tabbing to a message; the parity screenshots; the accessibility bar.
- [ ] Perf: JS gzip within +10 KB of R1.

## R3. Tool rows and pi parts

- [ ] Depends on: R2.
- [ ] Files: new `src/client/components/assistant-ui/tool-fallback.tsx` and `tool-group.tsx`, `src/client/Thread.tsx`, `src/client/styles.css`.
- [ ] Change: tool-call parts render the example's collapsible row, grouped with `MessagePrimitive.GroupedParts` when consecutive, with our status words as row labels (Running tool, Used tool, Failed tool, Cancelled tool) and diagnostics in the body. Run failures, compaction and reset notes, gaps, queued inputs, typing and compaction status, and the retry notice take the styles in the decisions table.
- [ ] Result you see: research shows "3 tool calls" collapsing to one row; a killed `slow_search` row reads Failed tool and stays open.
- [ ] Unit: `bun run check` and `bun run test` pass.
- [ ] Live: research (grouped rows, collapsed on completion), `slow_search` progress while running, a killed run's error box, a `crash_loop` fault, the parity screenshots, the accessibility bar (each row trigger is a button with an accessible name and `aria-expanded`).
- [ ] Perf: JS gzip within +5 KB of R2.

## R4. Dashboards and sign-in take the tokens

- [ ] Depends on: R3.
- [ ] Files: `src/client/App.tsx`, `src/client/ChatSession.tsx`, `src/client/ControlPanel.tsx`, `src/client/ActivityPanel.tsx`, `src/client/styles.css`.
- [ ] Change: the sidebar, Control panel, Activity panel, conversation header, and sign-in form use the shadcn `Button` and the tokens. Structure and behaviour stay. Today's responsive layout (Activity as an overlay below 75rem) is restyled in place.
- [ ] Result you see: one visual system across the page.
- [ ] Unit: `bun run check` and `bun run test` pass.
- [ ] Live: a wrong sign-in token shows the alert; set budgets; inject each fault; Kill conversation and Kill all; open a subagent from the Activity panel at 375 width; the accessibility bar.
- [ ] Perf: JS gzip within +3 KB of R3. CSS gzip ≤ 15,000.

## PR5. Conversation list on assistant-ui

**Why.** The sidebar list is a thread list. Moving it onto `ThreadListPrimitive` gives keyboard navigation and active state from the runtime, not from hand-kept `aria-current`. It is built in the example's sidebar style, which collapses to an off-canvas sheet on phones.

- [ ] Depends on: R4.
- [ ] Files: new `src/client/ConversationList.tsx`, new `src/client/components/ui/sheet.tsx`; `src/client/ChatSession.tsx`, `src/client/useSessionRuntime.ts`, `styles.css`.
- [ ] Change: `adapters.threadList` as in **Runtime wiring**. The list renders `ThreadListPrimitive.Root`, `New` (**New conversation**), and `Items` with `ThreadListItemPrimitive.Trigger`. The labels keep today's main, fork, and subagent wording. `?conversation=` URLs and back/forward still open the linked conversation. Archive, rename, and delete stay unset, because Pi Durable has no such commands. Below 48rem the sidebar becomes an off-canvas sheet (Radix Dialog) opened from a labelled menu button, with focus trapped while open and returned on close.
- [ ] Result you see: the same list. Clicking, back/forward, and **New conversation** behave as before.
- [ ] Unit: `bun run check` passes.
- [ ] Live: create two conversations, switch between them, press Back. Passes when the URL, the highlighted item, and the thread all agree after each step. Opening a subagent from the Activity panel highlights it in the list. At 375 width the sheet opens, traps focus, closes on Escape, and returns focus to the menu button.
- [ ] Perf: client JS gzip within +8 KB of R4 (Radix Dialog).

## PR6. Tool UIs and inline unsafe approval

**Why.** Each tool says what it did in its own terms, and the Fork Replay approval moves to the blocked `charge_credits` call. The operator approves where the block happens.

- [ ] Depends on: PR5.
- [ ] Files: new `src/client/tools/*.tsx`; `src/client/projection.ts`, `src/client/ControlPanel.tsx`, `src/replay.ts` (block message text only), `styles.css`.
- [ ] Change: `defineToolkit` with `type: "backend"` renderers for:
  - [ ] `search`: query and result titles.
  - [ ] `research`: the three subagent questions, each linked to its conversation.
  - [ ] `slow_search`: a staged progress line from the preliminary result.
  - [ ] `charge_credits`: credits, memo, and the matching Ledger entry. In a pending Fork Replay it shows an **Approve charge** card that calls `respondToApproval({ approved: true })`, which sends `run.approveUnsafe`.
  - [ ] `loop_forever` and `crash_loop`: a "fault tool" label.
  - [ ] Each renderer composes R3's collapsible tool row, and R3's row stays the fallback.
  - [ ] The Control panel keeps the replay provenance and a status line, and loses its approve button. The gate's block text changes from "approve it in the Control Panel" to "approve it on the blocked call".
- [ ] Result you see: tool cards in the tools' own terms. An approval card sits on the blocked charge. After approval the card reads "Approved", and the next charge in that conversation runs.
- [ ] Unit: `test/replay.test.ts` still passes. Projection test: approval flips from `false` to `true` across a snapshot that sets `approvedAt`.
- [ ] Live (SPEC acceptance test 4, through the UI): run a research task that charges credits, fork-replay it from the entry before the charge, and ask it to charge again. Passes when the charge card shows **Approve charge**, the Ledger stays at one entry, approval flips the card, and the retried charge adds exactly one Ledger entry.
- [ ] Perf: client JS gzip within +4 KB of PR5.

## PR7. Markdown, docs, and cleanup

**Why.** Answers with citations and lists read as raw text today. The docs must match the new client, and `styles.css` should not outlive the restyle.

- [ ] Depends on: PR6.
- [ ] Files: `src/client/Thread.tsx`, new `src/client/components/assistant-ui/markdown-text.tsx`, `package.json`, `README.md`, `SPEC.md`, `docs/adr/0006-*.md` (status to accepted); deletes `src/client/styles.css`.
- [ ] Change: text parts render through the example's `markdown-text.tsx` (`MarkdownTextPrimitive` with `remark-gfm`, `@assistant-ui/react-markdown/styles/dot.css`, code-block header with a copy button). `MessageText` is deleted. The README features table and Code column name `Thread.tsx`, `useSessionRuntime.ts`, `projection.ts`, and `tools/`. SPEC's Client bullet points to ADRs 0005 and 0006. `styles.css` is deleted once a grep of each of its selectors against `src/client` finds no user.
- [ ] Result you see: headings, lists, links, and code blocks render in answers.
- [ ] Unit: `bun run check` and `bun run test` pass.
- [ ] Live: ask a question whose answer has a numbered list and links. Passes when the list renders as `<ol>` and the links open in a new tab.
- [ ] Perf: client JS gzip ≤ 280,000 bytes in total (300,000 hard stop, operator sign-off). CSS gzip ≤ 15,000. Measure the markdown delta and name it in the commit.

---

## What stays unproven

- **Bundle cost in this build.** The 162 KB gzip figure is an esbuild measurement outside this repo. PR4's perf box measures it here.
- **Stream render cost.** The identity-reuse pass in the projection is designed, not measured. PR4's long-task box decides whether it is enough.
- **Kill run's scope.** The composer's **Kill run** is a run-scope Kill. The task graph does not expose a tool card's `callId`, so per-tool Kill stays in the Activity panel. Moving it onto tool cards needs the task id joined to the call id, and nothing in this plan builds that.
- **Restyle bundle cost.** The per-unit deltas in R1 to R4 are guesses until R1 measures Tailwind's CSS and the Radix pieces in this build.
- **API stability.** `ExternalStoreThreadListAdapter` and the toolkit API are marked experimental upstream, though not scheduled for removal. The versions are pinned exactly for that reason.
