import { MessagePrimitive, useAui } from "@assistant-ui/react";
import type { ToolDiagnostic } from "@earendil-works/pi-durable";
import { CheckIcon } from "lucide-react";
import { type ComponentProps, type ComponentType, useState } from "react";
import {
  ToolBlock,
  ToolFallback,
  type ToolRowStatus,
} from "../components/assistant-ui/tool-fallback.tsx";
import { Button } from "../components/ui/button.tsx";
import type { ToolArtifact } from "../projection.ts";

type PartState = Parameters<
  Extract<ComponentProps<typeof MessagePrimitive.Parts>["children"], (...args: never) => unknown>
>[0]["part"];
export type ToolCallPart = Extract<PartState, { readonly type: "tool-call" }>;

type Body = ComponentType<{ readonly part: ToolCallPart }>;

interface Hit {
  readonly id: string;
  readonly title: string;
}

interface SearchDetails {
  readonly query: string;
  readonly hits: readonly Hit[];
}

interface SlowSearchProgress {
  readonly stage: number;
  readonly stages: number;
  readonly query: string;
}

interface ResearchDetails {
  readonly question?: string;
  readonly conversationIds?: readonly number[];
  readonly answers?: readonly { readonly angle: string; readonly conversationId: number }[];
}

const toolBodies: Record<string, Body> = {
  search: SearchBody,
  slow_search: SlowSearchBody,
  research: ResearchBody,
};

const faultTools = new Set(["loop_forever", "crash_loop"]);

function toolRowStatus(part: ToolCallPart): ToolRowStatus {
  if (part.approval !== undefined) return "blocked";
  if (part.result !== undefined && part.isPreliminary !== true) {
    return part.isError === true ? "failed" : "completed";
  }
  switch (part.status.type) {
    case "running":
      return part.isPreliminary === true ? "running" : "waiting";
    case "incomplete":
      return part.status.reason === "error" ? "failed" : "cancelled";
    case "requires-action":
      return "waiting";
    default:
      return "completed";
  }
}

const detailsOf = <T,>(part: ToolCallPart): T | undefined =>
  ((part.artifact ?? {}) as ToolArtifact).details as T | undefined;

export function ToolCard({ part }: { readonly part: ToolCallPart }) {
  const Body = toolBodies[part.toolName] ?? GenericBody;
  const diagnostics = ((part.artifact ?? {}) as ToolArtifact).diagnostics;
  return (
    <ToolFallback
      toolName={part.toolName}
      note={faultTools.has(part.toolName) ? "fault tool" : undefined}
      status={toolRowStatus(part)}
    >
      <Body part={part} />
      {part.approval === undefined ? null : <Approve part={part} />}
      {diagnostics === undefined || diagnostics.length === 0 ? null : (
        <Diagnostics diagnostics={diagnostics} />
      )}
    </ToolFallback>
  );
}

function GenericBody({ part }: { readonly part: ToolCallPart }) {
  const details = detailsOf<unknown>(part);
  const output = typeof part.result === "string" ? part.result : undefined;
  return (
    <>
      {Object.keys(part.args).length === 0 ? null : (
        <ToolBlock label="Arguments">{JSON.stringify(part.args, null, 2)}</ToolBlock>
      )}
      {output === undefined || output.length === 0 ? null : (
        <ToolBlock label="Result">{output}</ToolBlock>
      )}
      {details === undefined ? null : (
        <ToolBlock label="Details">{JSON.stringify(details, null, 2)}</ToolBlock>
      )}
    </>
  );
}

function SearchBody({ part }: { readonly part: ToolCallPart }) {
  const details = detailsOf<SearchDetails>(part);
  if (details?.hits === undefined) return <GenericBody part={part} />;
  return <Hits query={details.query} hits={details.hits} />;
}

function Hits({ query, hits }: { readonly query: string; readonly hits: readonly Hit[] }) {
  return (
    <div className="flex flex-col gap-1">
      <p className="text-muted-foreground text-xs">
        Query: <span className="text-foreground">{query}</span>
      </p>
      {hits.length === 0 ? (
        <p className="text-muted-foreground text-xs">No results</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {hits.map((hit) => (
            <li key={hit.id} className="flex flex-col">
              <span>{hit.title}</span>
              <span className="text-muted-foreground font-mono text-xs [overflow-wrap:anywhere]">
                {hit.id}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SlowSearchBody({ part }: { readonly part: ToolCallPart }) {
  if (part.isPreliminary === true) {
    const progress = detailsOf<SlowSearchProgress>(part);
    if (progress?.stage === undefined) return null;
    return (
      <div className="flex flex-col gap-1.5">
        <p className="text-muted-foreground text-xs">
          Stage {progress.stage} of {progress.stages} for{" "}
          <span className="text-foreground">{progress.query}</span>
        </p>
        <progress
          className="accent-primary h-1.5 w-full max-w-60"
          value={progress.stage}
          max={progress.stages}
          aria-label="slow_search progress"
        />
      </div>
    );
  }
  return <SearchBody part={part} />;
}

function ResearchBody({ part }: { readonly part: ToolCallPart }) {
  const details = detailsOf<ResearchDetails>(part);
  const aui = useAui();
  const question =
    details?.question ?? (part.args as { readonly question?: string }).question ?? "";
  const subagents =
    details?.answers ??
    details?.conversationIds?.map((conversationId) => ({ angle: undefined, conversationId })) ??
    [];
  const open = (conversationId: number) => aui.threads().switchToThread(String(conversationId));
  return (
    <div className="flex flex-col gap-2">
      {question.length === 0 ? null : (
        <p className="text-muted-foreground text-xs">
          Question: <span className="text-foreground">{question}</span>
        </p>
      )}
      {subagents.length === 0 ? null : (
        <ul className="flex flex-col gap-1">
          {subagents.map(({ angle, conversationId }) => (
            <li key={conversationId} className="flex flex-wrap items-baseline gap-x-2">
              <span>{angle === undefined ? "Subagent" : capitalize(angle)}</span>
              <Button
                variant="link"
                size="xs"
                className="h-auto p-0"
                onClick={() => open(conversationId)}
              >
                Conversation #{conversationId}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Approve({ part }: { readonly part: ToolCallPart }) {
  const approved = part.approval?.approved === true;
  const [asked, setAsked] = useState(false);
  return (
    <div className="bg-muted/50 flex flex-col items-start gap-2 rounded-md p-3">
      <p className="text-sm">This call needs your approval in this replay.</p>
      {approved ? (
        <p
          ref={asked ? (node) => node?.focus() : undefined}
          tabIndex={-1}
          className="flex items-center gap-1.5 text-sm font-medium outline-none"
          role="status"
        >
          <CheckIcon aria-hidden className="size-4" />
          Approved. The next call in this conversation runs.
        </p>
      ) : (
        <Button
          size="sm"
          onClick={() => {
            setAsked(true);
            part.respondToApproval({ approved: true });
          }}
        >
          Approve
        </Button>
      )}
    </div>
  );
}

function Diagnostics({ diagnostics }: { readonly diagnostics: readonly ToolDiagnostic[] }) {
  return (
    <ul className="m-0 ps-5 text-xs">
      {diagnostics.map((diagnostic, index) => (
        <li key={`${diagnostic.code ?? "diagnostic"}-${index}`}>
          <strong>{capitalize(diagnostic.severity)}</strong>: {diagnostic.message}
        </li>
      ))}
    </ul>
  );
}

const capitalize = (value: string): string =>
  value.length === 0 ? value : value[0].toUpperCase() + value.slice(1);
