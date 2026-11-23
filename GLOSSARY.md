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
A new conversation forked from an existing one at a chosen entry, carrying completed tool results forward, created to redo the part of a run that failed. Unsafe tools in the carried part are not run again.
_Avoid_: Resume, rerun, retry

**Kill**:
An abort applied to a scope, ending that scope and everything it owns, bottom-up. A kill is either manual or a budget kill, and both end in the same terminal state.
_Avoid_: Cancel, stop, terminate (as the product term)

**Abort Scope**:
The thing a kill applies to. One of run, tool, conversation, or all.
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
A tool that is never run again automatically after an interruption. The model is told it was interrupted instead.
_Avoid_: Dangerous tool, write tool

**Ledger**:
The record of charges made by the sample agent, one entry per charge, recording the tool task that made it. A charge is idempotent on its intent within a conversation, so a retried charge returns the entry that already landed. The ledger is the proof that a charge fired exactly once.
_Avoid_: Payment log, transaction history

**Control**:
The stored settings that govern runs in a session. Budgets and kill state, held beside the transcript.
_Avoid_: Config, settings (as the domain term)

**Fault Tool**:
A shipped tool whose purpose is to be killed. It exists so kills and budget kills have real work to stop.
_Avoid_: Test tool, mock tool

**Session**:
One Durable Object holding one harness, its conversations, and its control and ledger state.
_Avoid_: Workspace, room
