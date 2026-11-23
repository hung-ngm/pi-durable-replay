import { type ReactNode, type SubmitEvent, useEffect, useState } from "react";
import { ChatSession } from "./ChatSession.tsx";
import { ensureSignedIn } from "./control-token.ts";

/** Single-user product (SPEC Q8): one operator, no accounts, no join flow. */
export const OPERATOR_USERNAME = "operator";

const sessionRoute = /^\/sessions\/([^/]+)\/?$/;

export function App() {
  const pathname = window.location.pathname;
  if (pathname === "/") return <LandingPage />;

  const match = sessionRoute.exec(pathname);
  if (match !== null && match[1].length > 0) {
    // Keep the session ID as the opaque encoded path segment PartySocket will reuse.
    return (
      <SignedIn>
        <ChatSession sessionId={match[1]} username={OPERATOR_USERNAME} />
      </SignedIn>
    );
  }

  return (
    <main>
      <h1>Page not found</h1>
      <p>
        <a href="/">Return to the landing page</a>
      </p>
    </main>
  );
}

/** Holds the session view until the browser is signed in, so its socket opens authorized. */
function SignedIn({ children }: { readonly children: ReactNode }) {
  const [state, setState] = useState<"checking" | "ready" | "failed">("checking");
  useEffect(() => {
    ensureSignedIn().then(
      () => setState("ready"),
      () => setState("failed"),
    );
  }, []);
  if (state === "ready") return children;
  if (state === "checking") return <main aria-busy="true" />;
  return (
    <main>
      <p role="alert">A control token is required to open this session.</p>
      <button type="button" onClick={() => window.location.reload()}>
        Sign in
      </button>
    </main>
  );
}

function LandingPage() {
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string>();

  const createSession = async (event: SubmitEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setCreating(true);
    setError(undefined);
    try {
      await ensureSignedIn();
      const response = await fetch("/api/sessions", { method: "POST" });
      if (!response.ok) throw new Error(`Session creation failed (${response.status})`);
      const result = (await response.json()) as { readonly url?: unknown };
      if (typeof result.url !== "string")
        throw new Error("The server returned an invalid session URL");
      window.location.assign(result.url);
    } catch (error) {
      setCreating(false);
      setError(error instanceof Error ? error.message : "Session creation failed");
    }
  };

  return (
    <main>
      <header>
        <h1>pi-durable-replay</h1>
        <p>
          Replay failed durable agent runs without re-firing their tools, and kill runaway loops
          before they spend.
        </p>
      </header>
      <section aria-labelledby="create-session-heading">
        <h2 id="create-session-heading">Start a session</h2>
        <p>Create an isolated durable session and run the research agent.</p>
        <form onSubmit={createSession}>
          <button type="submit" disabled={creating}>
            {creating ? "Creating session…" : "Create session"}
          </button>
        </form>
        {error === undefined ? null : <p role="alert">{error}</p>}
      </section>
    </main>
  );
}
