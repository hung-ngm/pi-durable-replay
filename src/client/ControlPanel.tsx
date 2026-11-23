import { type SubmitEvent, useEffect, useState } from "react";
import type { UsageState } from "@earendil-works/pi-durable";
import type { ControlView } from "../protocol.ts";
import { Button } from "./components/ui/button.tsx";
import { Input } from "./components/ui/input.tsx";

interface ControlPanelProps {
  readonly control: ControlView | undefined;
  readonly usage: UsageState | undefined;
  readonly activeConversationId: number | undefined;
  readonly onSetBudgets: (tokenBudget: number, turnBudget: number) => void;
  readonly onCrashNow: (conversationId: number) => void;
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

/** Budgets, kills, Crash now, replay provenance, and usage: the control plane in one panel. */
export function ControlPanel({
  control,
  usage,
  activeConversationId,
  onSetBudgets,
  onCrashNow,
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
  const replay =
    control === undefined || activeConversationId === undefined
      ? undefined
      : control.replays[String(activeConversationId)];

  return (
    <section className="flex flex-col gap-3 border-t p-4 text-sm" aria-labelledby="control-heading">
      <h2 id="control-heading">Control</h2>

      <form onSubmit={saveBudgets} className="flex flex-col gap-2">
        <p className="flex flex-col gap-1">
          <label htmlFor="token-budget" className="font-medium">
            Token budget per run
          </label>
          <Input
            className="h-8"
            id="token-budget"
            inputMode="numeric"
            value={tokenBudget}
            onChange={(event) => setTokenBudget(event.currentTarget.value)}
          />
        </p>
        <p className="flex flex-col gap-1">
          <label htmlFor="turn-budget" className="font-medium">
            Turn budget per run
          </label>
          <Input
            className="h-8"
            id="turn-budget"
            inputMode="numeric"
            value={turnBudget}
            onChange={(event) => setTurnBudget(event.currentTarget.value)}
          />
        </p>
        <Button type="submit" size="sm" className="self-start">
          Save budgets
        </Button>
        <p className="text-muted-foreground text-xs">New budgets apply to the next run only.</p>
      </form>

      <p>
        Tokens used in this conversation: <strong>{totalTokens(usage).toLocaleString()}</strong>
      </p>

      {lastKill === undefined ? null : (
        <p className="text-xs" role="status">
          Last kill: run ({lastKill.reason}
          {lastKill.budget === undefined ? "" : `: ${lastKill.budget} budget`}) at{" "}
          {new Date(lastKill.at).toLocaleTimeString()}
        </p>
      )}

      {replay === undefined ? null : (
        <div className="flex flex-col items-start gap-2">
          <p className="text-muted-foreground text-xs">
            Fork Replay of conversation #{replay.sourceConversationId}, forked at entry #
            {replay.forkEntryId}. Carried forward:{" "}
            {replay.carried.length === 0
              ? "no tool results"
              : replay.carried.map((entry) => entry.name).join(", ")}
            .
          </p>
          {replay.pendingUnsafeApproval ? (
            <p className="text-muted-foreground text-xs" role="status">
              The source conversation ran an unsafe tool. Running it here waits for your approval on
              the blocked call.
            </p>
          ) : replay.approvedAt === undefined ? null : (
            <p className="text-muted-foreground text-xs">Unsafe tools approved for this replay.</p>
          )}
        </div>
      )}
      <div className="flex flex-col items-start gap-2">
        <Button
          variant="secondary"
          size="sm"
          disabled={activeConversationId === undefined}
          onClick={() => {
            if (activeConversationId !== undefined) onCrashNow(activeConversationId);
          }}
        >
          Crash now
        </Button>
        <p className="text-muted-foreground text-xs">
          Evicts the Durable Object. The run wakes through its alarm and resumes from its last
          checkpoint.
        </p>
      </div>
      {control === undefined || control.kills.length === 0 ? null : (
        <>
          <h3>Kills</h3>
          <ul className="text-muted-foreground flex flex-col gap-1 text-xs">
            {[...control.kills].reverse().map((kill, index) => (
              <li key={`${kill.at}-${index}`}>
                run · {kill.reason}
                {kill.budget === undefined ? "" : ` · ${kill.budget}`}
                {kill.conversationId === undefined ? "" : ` · conversation #${kill.conversationId}`}
                {kill.taskId === undefined ? "" : ` · task #${kill.taskId}`} ·{" "}
                {new Date(kill.at).toLocaleTimeString()}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
