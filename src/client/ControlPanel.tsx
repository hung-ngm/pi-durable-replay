import { type SubmitEvent, useEffect, useState } from "react";
import type { UsageState } from "@earendil-works/pi-durable";
import type { ControlView } from "../protocol.ts";

interface ControlPanelProps {
  readonly control: ControlView | undefined;
  readonly usage: UsageState | undefined;
  readonly activeConversationId: number | undefined;
  readonly onSetBudgets: (tokenBudget: number, turnBudget: number) => void;
  readonly onAbortConversation: (conversationId: number) => void;
  readonly onAbortSession: () => void;
}

const totalTokens = (usage: UsageState | undefined): number => {
  if (usage === undefined) return 0;
  let total = 0;
  for (const bucket of [usage.models, usage.tools]) {
    for (const entry of Object.values(bucket))
      total += entry.totalTokens ?? entry.input + entry.output;
  }
  return total;
};

/** Budgets, kills, the ledger, and usage: the control plane in one panel (SPEC Shape A). */
export function ControlPanel({
  control,
  usage,
  activeConversationId,
  onSetBudgets,
  onAbortConversation,
  onAbortSession,
}: ControlPanelProps) {
  const [tokenBudget, setTokenBudget] = useState("");
  const [turnBudget, setTurnBudget] = useState("");

  useEffect(() => {
    if (control === undefined) return;
    setTokenBudget(String(control.tokenBudget));
    setTurnBudget(String(control.turnBudget));
  }, [control?.tokenBudget, control?.turnBudget]);

  const saveBudgets = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const tokens = Number.parseInt(tokenBudget, 10);
    const turns = Number.parseInt(turnBudget, 10);
    if (Number.isSafeInteger(tokens) && tokens > 0 && Number.isSafeInteger(turns) && turns > 0) {
      onSetBudgets(tokens, turns);
    }
  };

  const lastKill = control?.kills[control.kills.length - 1];

  return (
    <section className="control-panel" aria-labelledby="control-heading">
      <h2 id="control-heading">Control</h2>

      <form onSubmit={saveBudgets}>
        <p>
          <label htmlFor="token-budget">Token budget per run</label>{" "}
          <input
            id="token-budget"
            inputMode="numeric"
            value={tokenBudget}
            onChange={(event) => setTokenBudget(event.currentTarget.value)}
          />
        </p>
        <p>
          <label htmlFor="turn-budget">Turn budget per run</label>{" "}
          <input
            id="turn-budget"
            inputMode="numeric"
            value={turnBudget}
            onChange={(event) => setTurnBudget(event.currentTarget.value)}
          />
        </p>
        <button type="submit">Save budgets</button>
        <p className="control-note">New budgets apply to the next run only.</p>
      </form>

      <p className="control-usage">
        Tokens used in this conversation: <strong>{totalTokens(usage).toLocaleString()}</strong>
      </p>

      {lastKill === undefined ? null : (
        <p className="control-last-kill" role="status">
          Last kill: {lastKill.scope} ({lastKill.reason}
          {lastKill.budget === undefined ? "" : `: ${lastKill.budget} budget`}) at{" "}
          {new Date(lastKill.at).toLocaleTimeString()}
        </p>
      )}

      <div className="control-actions">
        <button
          type="button"
          disabled={activeConversationId === undefined}
          onClick={() => {
            if (activeConversationId !== undefined) onAbortConversation(activeConversationId);
          }}
        >
          Kill conversation
        </button>
        <button type="button" onClick={onAbortSession}>
          Kill all
        </button>
      </div>

      {control === undefined || control.kills.length === 0 ? null : (
        <>
          <h3>Kills</h3>
          <ul className="control-kills">
            {[...control.kills].reverse().map((kill, index) => (
              <li key={`${kill.at}-${index}`}>
                {kill.scope} · {kill.reason}
                {kill.budget === undefined ? "" : ` · ${kill.budget}`}
                {kill.conversationId === undefined ? "" : ` · conversation #${kill.conversationId}`}
                {kill.taskId === undefined ? "" : ` · task #${kill.taskId}`} ·{" "}
                {new Date(kill.at).toLocaleTimeString()}
              </li>
            ))}
          </ul>
        </>
      )}

      {control === undefined || control.ledger.length === 0 ? null : (
        <>
          <h3>Ledger</h3>
          <ul className="control-ledger">
            {control.ledger.map((entry) => (
              <li key={entry.taskId}>
                {entry.credits} credits · {entry.memo} · task #{entry.taskId} ·{" "}
                {new Date(entry.at).toLocaleTimeString()}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
