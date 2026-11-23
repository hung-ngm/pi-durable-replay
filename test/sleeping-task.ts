import { defineTask } from "@earendil-works/pi-durable";

/**
 * Minimal durable task used as a fixture by tests that need a real task definition
 * (task-owned conversations, eviction recovery) without depending on application tasks.
 * It sleeps until `runAt`, then completes.
 */
export const SleepingTask = defineTask<
  { readonly runAt: number },
  { readonly phase: "wait" | "done" },
  null
>({
  name: "test.sleeping-task",
  version: 1,
  initial: () => ({ phase: "wait" }),
  phases: {
    wait: (task, runtime, context) =>
      runtime.sleepUntil(task.input.runAt, { phase: "done" }, context),
    done: async (_task, runtime, context) => {
      await runtime.commit(
        () => ({ status: "terminal", outcome: { status: "completed", result: null } }),
        context,
      );
    },
  },
  abort: async (_task, runtime, context) => {
    await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
  },
});
