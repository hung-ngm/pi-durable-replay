# Plan: simplify the demo to three features

Status: draft, 24 Nov 2026. Awaiting the operator's go.

## What changes

The app demonstrates three pi-durable features and nothing else:

1. **Cost control.** Per-run token and turn budgets, enforced by the Budget Kill.
2. **Kill switch.** The composer's Stop kills the live run. The Control panel's kill log shows every kill and why it fired.
3. **Replay without re-firing effects.** Fork Replay carries completed tool results forward, so `search` and `research` do not run again. `loop_forever` stays blocked until the operator approves it on the blocked call.

The tools are `search` and `research` (safe) and `loop_forever` (unsafe). **Crash now**, which is Evict renamed, stays as the one fault. It shows that a run survives eviction and resumes from its last checkpoint.

Removed: `charge_credits` and the Ledger, `slow_search`, `crash_loop`, `FaultDoc`, `CrashDoc`, the crash-loop watcher and its fast heartbeat, the Interrupt unsafe tool fault, and the buttons Interrupt unsafe tool, Crash-loop tool, Kill conversation, Kill all, the per-task Kill buttons in Activity, and the plain Fork action.

The Ledger-refresh change is already committed (`1d7c91d`). Unit 1 drops `"app.ledger"` and unit 2 drops `"app.crash"` from `CONTROL_VIEW_KINDS`. `changesControlView`, its test, and `#scheduleSnapshotBroadcast` stay.

## Data shapes after the change

```ts
// src/protocol.ts
interface ControlView {
  tokenBudget: number;
  turnBudget: number;
  kills: KillRecord[];
  replays: Record<string, ReplayState>; // ledger and crashAttempts removed
}

// src/control.ts
type AbortScope = "run"; // "tool", "conversation", and "all" lose every caller
const CONTROL_VIEW_KINDS = new Set(["app.control", "app.replay"]);

// src/replay.ts, unchanged shape, new arming rule
type ReplayState = {
  sourceConversationId: number;
  forkEntryId: number;
  carried: CarriedToolResult[];
  pendingUnsafeApproval: boolean; // true when the source conversation called loop_forever
  approvedAt?: number;
};
```

Protocol commands removed: `conversation.fork`, `conversation.abort`, `session.abort`. `task.abort` accepts only `scope: "run"`. `fault.inject` loses `kind`, because evict is the only fault left.

## The gate's arming rule

Today the gate arms when the Ledger holds a charge from the source conversation. The Ledger is the record of effects that happened, not the carried transcript. With the Ledger gone, the equivalent record is the source conversation's committed `loop_forever` tool call. A tool call commits before its tool runs, so the call proves the loop started. The rule scans the whole source conversation, not only entries up to the fork point. A loop whose call sits after the fork point still happened, so the fork still asks.

The alternative is to arm every Fork Replay. It is one line shorter, but it would ask for approval in forks whose source never looped. ADR 0004 says a fork never re-runs an unsafe tool without fresh approval. "Re-runs" fits the source-call rule.

## Units

Each unit lands on `main` as one commit. Before each push, run `/deslop`, `bun run check`, and `bun run test`. Then push, wait for the deploy workflow, and check on the deployed app. Signing in to the deployed app needs the operator to enter `CONTROL_TOKEN` in the browser pane. Each check runs in a new session, because existing sessions keep orphaned docs and in-flight tool tasks for tools that no longer exist.

### Unit 1: remove `charge_credits` and the Ledger

- [ ] Depends on: nothing.
- [ ] Files: `src/tools.ts`, `src/replay.ts`, `src/session.ts`, `src/control.ts`, `src/protocol.ts`, `src/agent.ts`, `src/client/ControlPanel.tsx`, `src/client/tools/ToolCard.tsx`, `src/client/projection.ts`, `test/agent.test.ts`, `test/replay.test.ts`, `test/control.test.ts`, `test/projection.test.ts`, `test/auth.test.ts`, `scripts/e2e-live.ts`, `scripts/e2e-research.ts`.
- [ ] Change: delete the tool, `LedgerDoc`, `ControlView.ledger`, the Ledger list, the Interrupt unsafe tool fault and button (it only targets `charge_credits`), `ChargeBody` and `ApproveCharge`, and the agent prompt's charge instructions. The gate stays in place but no longer arms (`pendingUnsafeApproval` is always false) until unit 4. Replay test 3 is deleted. Test 4 keeps its carry-forward assertions and loses its charge assertions. The freshness test uses `app.replay` in place of `app.ledger`.
- [ ] Result: the Control panel shows no Ledger and no Interrupt button. The agent never offers to charge.
- [ ] Live check: in a new session, ask a research question. It fans out, answers with citations, and the snapshot carries no `ledger` field.

### Unit 2: remove `slow_search`, `crash_loop`, and the fault machinery; rename Evict

- [ ] Depends on: unit 1 (both edit `fault.inject`).
- [ ] Files: `src/tools.ts`, `src/faults.ts` (deleted), `src/session.ts`, `src/control.ts`, `src/protocol.ts`, `src/client/ControlPanel.tsx`, `src/client/tools/ToolCard.tsx`, `test/faults.test.ts`, `test/control.test.ts`, `test/agent.test.ts`, `scripts/local-kill-demo.*` (deleted), `package.json`.
- [ ] Change: delete both tools, `CrashDoc`, `FaultDoc`, `#scheduleCrashLoopCheck`, `#fastHeartbeat`, `ControlView.crashAttempts`, and `fault.inject`'s `kind`. The Evict button becomes **Crash now**. Test 6 is deleted. Control test 1 kills a run during `research` in place of `slow_search`. The `kill -9` local demo goes, because it is built on `slow_search` and `charge_credits`, and Crash now shows the same recovery on the deployed app.
- [ ] Result: the Control panel's fault section is one **Crash now** button.
- [ ] Live check: start a research question, press Crash now while subagents run, and confirm that the run resumes and answers.

### Unit 3: remove the extra kill scopes and the plain Fork

- [ ] Depends on: unit 2 (both edit `ControlPanel.tsx` and `session.ts`).
- [ ] Files: `src/control.ts`, `src/session.ts`, `src/protocol.ts`, `src/client/ControlPanel.tsx`, `src/client/ActivityPanel.tsx`, `src/client/ChatSession.tsx`, `src/client/Thread.tsx`, `src/client/usePiSession.ts`, `test/chat.test.ts`, `test/activity.test.tsx`, `test/control.test.ts`.
- [ ] Change: delete Kill conversation, Kill all, the Activity Kill buttons and `onAbortTask`, the Fork action and `forkConversation`, plus the three protocol commands and the `tool`, `conversation`, and `all` branches of `kill()`. The chat test "creates a durable fork" is deleted, because the replay tests cover forking.
- [ ] Result: Activity is read-only. The Control panel holds budgets, usage, Crash now, the kill log, and replay provenance. Assistant messages with tool calls offer Fork Replay only.
- [ ] Live check: Stop on a running research question records a `run · manual` kill. Activity shows no buttons. The message actions show Fork Replay and no Fork.

### Unit 4: point the gate and the Approve card at `loop_forever`

- [ ] Depends on: unit 3.
- [ ] Files: `src/replay.ts`, `src/protocol.ts`, `src/client/tools/ToolCard.tsx`, `src/client/projection.ts`, `src/client/ControlPanel.tsx`, `test/replay.test.ts`, `test/projection.test.ts`, `docs/adr/0004-resume-and-fork-replay-are-the-only-replay-modes.md`.
- [ ] Change: `replayFork` arms from the source conversation's `loop_forever` calls, and `unsafeGateHook` blocks `loop_forever`. The `loop_forever` card carries **Approve loop**. `isBlockedCharge` becomes `isBlockedCall`. ADR 0004 gets an amendment that names the new arming source.
- [ ] Tests: a source runs `search` and then `loop_forever`, and a Stop ends it. Fork Replay from the entry after `search` carries `search`, does not run it again, and blocks `loop_forever` until approval. A fork taken before the loop call still blocks.
- [ ] Result: the three features read as one story. Run a loop, kill it, Fork Replay, and approve. The loop runs again and the Budget Kill stops it.
- [ ] Live check: on the deployed app, follow that story end to end. The blocked `loop_forever` card shows Approve loop. After approval the kill log shows `run · budget · turns`.

### Unit 5: docs

- [ ] Depends on: unit 4.
- [ ] Files: `README.md`, `SPEC.md`, `GLOSSARY.md`, `src/corpus.ts` (only where it describes this app's tools).
- [ ] Change: the feature table, diagrams, acceptance tests, and glossary describe the three features. The Ledger, Fault Tool, and exactly-once charge entries go.
- [ ] Live check: none. The docs match the deployed app as checked in unit 4.

## What stays unproven

- No perf check. The change only deletes code and moves one rule, and no hot path gains work. The `loop_forever` scan in `replayFork` reads the source conversation once per Fork Replay, as the Ledger read did.
- Old deployed sessions are not migrated. Their `app.ledger`, `app.fault`, and `app.crash` documents stay in SQLite unread. A tool task for a removed tool that is still in flight there fails on resume.
