# pi-durable-replay

A control plane for durable agent runs, built on [`@earendil-works/pi-durable`](https://www.npmjs.com/package/@earendil-works/pi-durable) running in a Cloudflare Durable Object: replay failed runs without re-firing their tools, and kill runaway loops before they spend. Forked from [`earendil-works/pi-durable-cloudflare`](https://github.com/earendil-works/pi-durable-cloudflare); see [SPEC.md](SPEC.md) for the product definition and [docs/adr](docs/adr) for the decisions.

Start with the [Pi Durable announcement](https://earendil.com/posts/pi-durable/) for the ideas behind the harness.

Pi Durable is experimental, so its APIs may still change.

## What you can try

- Create a session and run several conversations at once; fork a conversation from an earlier message.
- Reconnect without losing committed transcripts or queued prompts.
- Open Activity to inspect live task ownership, waits, sleeps, tool calls, and background work while conversations run.

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

Open the local URL printed by Vite, create a session, and send a message. Open the session URL in another browser to try the multiplayer flow.

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

Authenticate Wrangler, store the API key as a Worker secret, then deploy:

```sh
bunx wrangler login
bunx wrangler secret put OPENAI_API_KEY
bun run deploy
```

Before exposing a deployment, add authentication, authorization, and rate limiting. Anyone who can reach this sample can create sessions that use your model credentials.

## Further reading

- [Pi Durable announcement](https://earendil.com/posts/pi-durable/)
- [pi-durable package documentation](https://github.com/earendil-works/pi/tree/main/packages/durable)
- [pi-durable examples](https://github.com/earendil-works/pi/tree/main/packages/durable/test/examples)
- [Cloudflare Durable Objects](https://developers.cloudflare.com/durable-objects/)
