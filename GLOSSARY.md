# Pi Durable Replay

A control plane for one Pi Durable agent. It watches runs, stops them, and replays their failures without repeating effects that already happened.

## Language

**Run**:
One answer in progress, from a submitted input to its final answer or its terminal failure. A run is made of turns.
_Avoid_: Job, execution, session

**Resume**:
Continuing the same run from its last committed checkpoint after an interruption. The run keeps its identity.
_Avoid_: Replay, retry, restart

**Fork Replay**:
A new conversation forked from an existing one at a chosen entry, carrying completed tool results forward, created to redo the part of a run that failed. Carried tool results do not run again. An unsafe tool that the source conversation called waits for fresh approval in the fork.
_Avoid_: Resume, rerun, retry

**Kill**:
An abort applied to a run, ending the run and everything it owns, bottom-up. A kill is either manual, from **Kill run**, or a budget kill, and both end in the same terminal state. The kill log in Control records each kill and its reason.
_Avoid_: Cancel, stop, terminate (as the product term)

**Abort Scope**:
The thing a kill applies to. In this app it is always a run.
_Avoid_: Target, level

**Budget Kill**:
A kill fired automatically when a run crosses its token budget or its turn budget.
_Avoid_: Timeout, quota error

**Tool Intent**:
The committed record of a tool call before it runs, holding its final arguments and its replay policy. It is the tool task's own checkpoint, not a separate store.
_Avoid_: Tool log, tool history

**Safe Tool**:
A tool declared safe to run again after an interruption because running it twice changes nothing.
_Avoid_: Read-only tool (a safe tool is usually read-only, but safety is the declared replay property, not the read)

**Unsafe Tool**:
A tool that is never run again automatically after an interruption. The model is told it was interrupted instead. In a Fork Replay whose source called it, it waits for the operator's approval. `loop_forever` is the one unsafe tool.
_Avoid_: Dangerous tool, write tool

**Control**:
The stored settings that govern runs in a session. Budgets and the kill log, held beside the transcript.
_Avoid_: Config, settings (as the domain term)

**Fault Tool**:
A shipped tool whose purpose is to be killed. `loop_forever` is the one fault tool. It exists so kills and budget kills have real work to stop.
_Avoid_: Test tool, mock tool

**Crash now**:
The one injected fault. It evicts the session's Durable Object mid-run, and the alarm wakes it to resume the run from its last checkpoint.
_Avoid_: Evict, crash test

**Session**:
One Durable Object holding one harness, its conversations, and its control and replay state.
_Avoid_: Workspace, room
