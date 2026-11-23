# pi-durable-replay

A control plane for durable agent runs, built on [`@earendil-works/pi-durable`](https://www.npmjs.com/package/@earendil-works/pi-durable) running in a Cloudflare Durable Object: replay failed runs without re-firing their tools, and kill runaway loops before they spend. Forked from [`earendil-works/pi-durable-cloudflare`](https://github.com/earendil-works/pi-durable-cloudflare); see [SPEC.md](SPEC.md) for the product definition and [docs/adr](docs/adr) for the decisions.

Start with the [Pi Durable announcement](https://earendil.com/posts/pi-durable/) for the ideas behind the harness.

Pi Durable is experimental, so its APIs may still change.

## What you can try

- Ask the research agent a question: it fans out to three parallel subagent conversations, searches a built-in corpus, and synthesizes an answer with citations.
- Watch every run as a live task graph in the Activity panel, and kill work at four scopes: a tool, a run, a conversation, or the whole session.
- Set per-run budgets (default 100,000 tokens or 30 turns) in the Control Panel. A run that crosses one is budget-killed, and the panel names which budget fired. Budget edits apply to the next run only.
- Fail a run, then use Replay on an earlier entry: Fork Replay carries completed tool results forward as history, so safe tools never run again, and the unsafe `charge_credits` tool stays blocked until you approve it in the Control Panel. The Ledger beside the transcript proves each charge landed exactly once.
- Inject faults from the Control Panel: interrupt a live charge, arm a crash loop that cuts the object off until the tool ends at its restart limit, or evict the Durable Object and watch the run resume through its alarm.

This is a single-user tool, not a production service.

## Run it locally

You need Bun 1.4 or newer and an OpenAI API key. Tests run on Vitest (invoked through Bun) because the Cloudflare workers pool has no bun test equivalent.

```sh
bun install
cp .dev.vars.example .dev.vars
```

Add your key to `.dev.vars`:

```dotenv
OPENAI_API_KEY=your-key
```

Then start the Worker and React client together:

```sh
bun run dev
```

Open the local URL printed by Vite, create a session, and send a message.

### Local kill -9 demo

The same resume guarantees hold outside Cloudflare. This script starts the agent under Bun over a file-backed store, kills it with `kill -9` in the middle of a tool call, then reopens the store in a fresh process and resumes:

```sh
OPENAI_API_KEY=... bun run demo:local-kill
```

It runs two scenarios and prints the full transcript of each: a safe tool (`slow_search`) reruns and completes after the kill, and an unsafe tool (`charge_credits`) is reported interrupted, is never re-fired, and leaves exactly one Ledger entry.

## Where to look

The shortest path through the project is:

- [`src/chat.ts`](src/chat.ts) defines the models, extensions, tools, and default agent.
- [`src/session.ts`](src/session.ts) hosts the harness with Pi Durable's built-in Durable Object SQLite storage and connects it to Cloudflare's native hibernating WebSockets and alarms. Each socket watches one conversation's view (`Conversation.watch()`): the server sends its first value, then its changes as Chord operations, and pages older entries on request.
- [`src/tools.ts`](src/tools.ts), [`src/schedule.ts`](src/schedule.ts), and [`src/search.ts`](src/search.ts) contain the example tools and tasks.
- [`src/client/`](src/client/) is the React client. It applies the operations to each conversation's view, keeps the whole transcript with Pi Durable's `ConversationTranscript`, and renders the result: entries, and `pi.live` for the run, the streamed answer, tool progress, and failures.
- [`test/`](test/) covers application flows including restart recovery, scheduling, forks, and inboxes. Pi Durable tests its built-in Cloudflare storage adapter inside a Durable Object itself.

The code is the documentation for this integration. In particular, the tests are useful examples of restart behavior, scheduling, forks, and inboxes.

## Commands

```sh
bun run dev     # local development
bun run test    # test suite (Vitest, via bun run)
bun run check   # formatting, types, build, and deploy dry run
bun run build   # production build
bun run preview # preview the production build locally
```

## Deploy

Deployment runs in GitHub Actions (`.github/workflows/deploy.yml`), not from a local Wrangler: every push to `main` runs the checks and the test suite, then deploys. One-time setup, all in your own browser sessions:

1. In the Cloudflare dashboard, create an account API token with the **Edit Cloudflare Workers** permission policy, scoped to your account, and note your account ID.
2. In this repo's GitHub settings (Secrets and variables > Actions), add four repository secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `OPENAI_API_KEY` (your existing provider key), and `CONTROL_TOKEN` (a password you choose for this app).
3. Push to `main`, or run the workflow manually from the Actions tab.

The workflow uploads `OPENAI_API_KEY` and `CONTROL_TOKEN` as Worker secrets in the same operation as the deploy (`wrangler deploy --secrets-file`), from a file that exists only in the runner's temp directory.

Scripts send `Authorization: Bearer <CONTROL_TOKEN>` on session creation and on the session WebSocket. The browser UI prompts once, posts the token to `/api/auth`, and receives an `HttpOnly; Secure; SameSite=Strict` cookie holding a digest of the token, valid for 30 days; every tab and every WebSocket upgrade send it automatically, and the token never appears in a URL or in page storage. Rotating `CONTROL_TOKEN` signs every browser out. A deployment must always set CONTROL_TOKEN: without it the API is open, which is only acceptable for local development.

## Further reading

- [Pi Durable announcement](https://earendil.com/posts/pi-durable/)
- [pi-durable package documentation](https://github.com/earendil-works/pi/tree/main/packages/durable)
- [pi-durable examples](https://github.com/earendil-works/pi/tree/main/packages/durable/test/examples)
- [Cloudflare Durable Objects](https://developers.cloudflare.com/durable-objects/)
