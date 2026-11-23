# Implementation plan - pi-durable-replay

Agreed 23 Nov 2026. Every unit ends in a check. A unit that is not green is not done, and the next unit does not start. Commits credit Hùng as author with the `Co-authored-by: Muse <muse@local>` trailer, per the standing rule. The repo gets all 58 pstack skills plus the 20 Matt Pocock engineering skills in `.agents/skills/` with `.claude/skills/` symlinks, at repo creation, per the standing rule.

## Unit 0 - Fork and rename

- `gh repo fork earendil-works/pi-durable-cloudflare` into `hung-ngm/pi-durable-replay`, public, upstream remote kept, MIT notice retained.
- Install the 78 skills. Set repo-local git author.
- Check: repo exists, upstream remote present, no code changed yet.

## Unit 1 - Bump pi-durable to 1.6.0 (on the original pnpm base)

- Bump `@earendil-works/pi-durable`, `pi-ai`, `chord`, `pi-schema` from 1.5.2 to 1.6.0. Nothing else in the diff.
- Check: `pnpm check` and the full test suite green. Any breakage here is upstream's API drift, fixed in this unit and named in the commit.

## Unit 2 - Migrate the toolchain to Bun

- Remove `pnpm-lock.yaml` and the `packageManager: pnpm` field. Add `bun.lock`, `packageManager` set to Bun, engines set to Bun, all scripts and README commands switched to `bun` / `bun run` / `bunx`.
- Vitest stays, invoked by `bun run`. Wrangler stays, invoked through Bun.
- Check: from a clean checkout, `bun install`, `bun run check`, and the full test suite green, including `test/recovery.test.ts`. If the Cloudflare workers pool breaks under Bun, stop and report. No silent Node fallback (ADR 0002).

## Unit 3 - Docs enter the repo

- Copy SPEC.md, GLOSSARY.md, and docs/adr/0001-0004 from the staging folder into the repo root, unchanged.
- Check: docs match the staged copies byte for byte.

## Unit 4 - Subtract the demo

- Delete `src/tools.ts` weather tool, `src/schedule.ts`, `src/search.ts`, the username join flow in `App.tsx`, and chat branding. Keep one read of `search.ts` as the subagent pattern reference before deleting.
- Check: check suite and tests green with the demo gone, adjusting only tests that covered demo behaviour, and naming each removed test in the commit.

## Unit 5 - Auth at the seam

- Bearer token check in `src/index.ts` where upstream marks the demo-only surface. Token from the `CONTROL_TOKEN` secret. UI prompts once and keeps the token in session storage only.
- Check: a request without the token gets 401 on the API and on session creation. A request with it works. A test covers both.

## Unit 6 - The sample agent

- `src/agent.ts`: OpenAI provider via pi-ai, fork's default model, per-conversation model override kept.
- `src/tools.ts`: `search` (built-in corpus, deterministic, seeded; Exa behind `SEARCH_BACKEND=exa`), the three-way subagent fan-out, `charge_credits` writing `LedgerDoc` keyed by tool task id, `slow_search`, `loop_forever`.
- Check: a research prompt completes with three subagent conversations visible in the task graph, one Ledger entry per charge, and tests using pi-ai's faux provider cover the fan-out and the charge.

## Unit 7 - Control: budgets and kills

- `src/control.ts`: `ControlDoc` (default 100,000 tokens, 30 turns), budget hook, kill handling for the four Abort Scopes over the ownership tree.
- Protocol: `task.abort`, `conversation.abort`, `control.setBudgets`. Client: abort buttons in `ActivityPanel`, budgets in `ControlPanel`, usage from `pi.usage`.
- Check: acceptance tests 1, 2, and 8 from the SPEC pass.

## Unit 8 - Replay

- `src/replay.ts`: Fork Replay plus `ReplayDoc`. Protocol: `run.replayFork`. Client: replay control on a failed run, carried results shown on the fork.
- Approval gate for an unsafe tool in a replay, using a hook memo so approval is asked once across crashes.
- Check: acceptance tests 3 and 4 pass, including exactly one Ledger entry after interrupt, resume, and replay combined.

## Unit 9 - Fault panel and local kill demo

- Protocol: `fault.inject`. Client: one fault panel driving the interrupted unsafe tool, the crash-loop tool, and DO eviction.
- Local Bun demo script: start the harness locally, `kill -9` mid-tool-call, reopen, resume, print the transcript and the Ledger before and after.
- Check: acceptance tests 5, 6, and 7 pass. The local demo prints a full terminal transcript, per the operator's standing preference for CLI demos.

## Unit 10 - Deploy (gated)

- Show the operator the exact wrangler target and secret names. Deploy only on the operator's explicit go-ahead.
- `wrangler secret put OPENAI_API_KEY` and `CONTROL_TOKEN`. Deploy Worker name `pi-durable-replay` to its `workers.dev` address.
- Check: the live URL answers, a full research run completes on the deploy, a kill works on the deploy, and the eviction fault resumes on the deploy. Verify the live page by a marker that exists only in the new build.

## Risks, named

- pi-durable is experimental and breaks its API between releases. Mitigation: pinned versions, one bump per unit, upstream remote kept for diffing.
- The Cloudflare workers pool may not run under Bun. Mitigation: Unit 2 is a hard gate with a stop-and-report rule.
- One maintainer upstream on the fork base. Mitigation: the base is small (about 7,200 lines) and we own our fork outright under MIT.
- Bun on this VM: installs and local runs are fine. Docker is not available on the VM, and none of this plan needs it. Wrangler's local Miniflare runs under Bun is an open question that Unit 2 answers with evidence, not hope.
