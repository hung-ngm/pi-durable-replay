/**
 * The built-in search corpus: a small, fixed set of documents about durable agent
 * execution, so `search` is deterministic and offline by default (SPEC Q14).
 * Seeded content; ranking is a stable term-frequency score with ID tie-breaks.
 */
export type CorpusDocument = {
  id: string;
  title: string;
  text: string;
};

export const CORPUS: readonly CorpusDocument[] = [
  {
    id: "corpus:checkpoints",
    title: "Checkpoints and resume",
    text: "A durable agent commits its state before any effect becomes visible. On restart it resumes from the last committed checkpoint instead of replaying its code. Work committed before the interruption is never repeated; work that was only in memory is redone from the checkpoint.",
  },
  {
    id: "corpus:replay-safety",
    title: "Replay-safe and unsafe tools",
    text: "A tool declares whether replaying it is safe. Safe tools are reads and idempotent writes: search, lookups, and queries. Unsafe tools move money, send messages, or charge credits. An unsafe tool that was interrupted mid-call is never silently rerun; it stays interrupted until a person decides.",
  },
  {
    id: "corpus:idempotency-keys",
    title: "Idempotency keys make effects exactly-once",
    text: "An effect keyed by a stable idempotency key can be attempted many times and land once. Keying a charge by the tool task ID means a crash, a retry, and a resume all converge on a single ledger entry. The key must be written before the effect, in the same commit as the intent.",
  },
  {
    id: "corpus:kill-switches",
    title: "Kill switches for runaway agents",
    text: "A kill switch aborts a run, a tool call, a conversation, or a whole session. Aborting a scope aborts everything it owns, bottom-up, so each owned task cleans up its own effect first. A budget kill is the same kill fired by the system when a token or turn budget is crossed.",
  },
  {
    id: "corpus:budget-kills",
    title: "Token and turn budgets",
    text: "Budgets cap what one run may spend: a token budget and a turn budget, whichever fires first. Usage is metered from the committed usage document, so the count survives restarts. Budget changes apply to the next run, never retroactively to a run in flight.",
  },
  {
    id: "corpus:fork-replay",
    title: "Fork replay",
    text: "Fork replay starts a new conversation from the entry before a failure. Tool results already committed are carried forward as entries, so safe tools do not run again. Unsafe tools in the carried history are shown as completed effects; running them again needs fresh explicit approval.",
  },
  {
    id: "corpus:subagents",
    title: "Subagents as durable tasks",
    text: "A subagent is a conversation owned by the task that created it. Ownership is the durable record: a rerun finds the child it already created instead of making another. Subagents run in parallel, each in its own conversation, and the parent receives only their answers.",
  },
  {
    id: "corpus:alarms-eviction",
    title: "Eviction, alarms, and waking",
    text: "A Durable Object can be evicted at any time. Sleeping tasks hold no invocation; an alarm wakes the object at the earliest deadline, and the harness resumes what was sleeping. A heartbeat alarm bounds how long an eviction can go unnoticed.",
  },
  {
    id: "corpus:restart-limits",
    title: "Restart limits stop crash loops",
    text: "A task that crashes on every restart would loop forever. A restart limit ends the task after a fixed number of restarts and reports it as a restart-limit failure. Five restarts is a common default: enough for transient faults, few enough to stop a loop quickly.",
  },
  {
    id: "corpus:compaction",
    title: "Compaction keeps the transcript, drops the weight",
    text: "Compaction summarizes older context into a smaller committed entry. It never deletes the underlying history; the full record stays in storage. An agent whose memory survives compaction can be forked from before or after the summary.",
  },
  {
    id: "corpus:cost-metering",
    title: "Metering model cost",
    text: "Every model request records its token usage in a usage document beside the transcript. Cost control reads that document: totals per run, per conversation, and per session. Metering from committed usage, not from logs, means the numbers survive crashes and eviction.",
  },
];

export type CorpusHit = {
  id: string;
  title: string;
  snippet: string;
  score: number;
};

const terms = (value: string): string[] =>
  value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length > 2);

/** Deterministic term-frequency search over the corpus. Same query, same hits, forever. */
export function searchCorpus(query: string, limit = 3): CorpusHit[] {
  const queryTerms = [...new Set(terms(query))];
  if (queryTerms.length === 0) return [];
  const hits: CorpusHit[] = [];
  for (const doc of CORPUS) {
    const haystack = `${doc.title} ${doc.text}`.toLowerCase();
    let score = 0;
    for (const term of queryTerms) {
      score += haystack.split(term).length - 1;
    }
    if (score === 0) continue;
    const firstTerm = queryTerms.find((term) => haystack.includes(term))!;
    const index = Math.max(0, haystack.indexOf(firstTerm) - 60);
    const snippet = `${index > 0 ? "…" : ""}${doc.text.slice(index, index + 180)}${index + 180 < doc.text.length ? "…" : ""}`;
    hits.push({ id: doc.id, title: doc.title, snippet, score });
  }
  hits.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return hits.slice(0, limit);
}
