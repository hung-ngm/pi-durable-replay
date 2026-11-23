import { type ReactNode, type SubmitEvent, useEffect, useState } from "react";
import { ChatSession } from "./ChatSession.tsx";
import { Button } from "./components/ui/button.tsx";
import { Input } from "./components/ui/input.tsx";
import { isSignedIn, signIn } from "./control-token.ts";

/** Single-user product (SPEC Q8): one operator, no accounts, no join flow. */
export const OPERATOR_USERNAME = "operator";

const page = "mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-6 px-4 py-8";

const sessionRoute = /^\/sessions\/([^/]+)\/?$/;

export function App() {
  const pathname = window.location.pathname;
  if (pathname === "/") {
    return (
      <SignedIn>
        <LandingPage />
      </SignedIn>
    );
  }

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
    <main className={page}>
      <h1>Page not found</h1>
      <p>
        <a href="/">Return to the landing page</a>
      </p>
    </main>
  );
}

function SignedIn({ children }: { readonly children: ReactNode }) {
  const [state, setState] = useState<"checking" | "signed-out" | "signed-in">("checking");
  useEffect(() => {
    isSignedIn().then(
      (signedIn) => setState(signedIn ? "signed-in" : "signed-out"),
      () => setState("signed-out"),
    );
  }, []);
  if (state === "signed-in") return children;
  if (state === "checking") return <main aria-busy="true" />;
  return <SignInForm onSignedIn={() => setState("signed-in")} />;
}

function SignInForm({ onSignedIn }: { readonly onSignedIn: () => void }) {
  const [token, setToken] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async (event: SubmitEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setPending(true);
    setError(undefined);
    try {
      if ((await signIn(token)) === "accepted") {
        onSignedIn();
        return;
      }
      setError("That control token was wrong.");
    } catch (error) {
      setError(error instanceof Error ? error.message : "Sign-in failed");
    }
    setPending(false);
  };

  return (
    <main className={page}>
      <h1>pi-durable-replay</h1>
      <form className="flex flex-col gap-3" onSubmit={submit}>
        <label htmlFor="control-token" className="text-sm font-medium">
          Control token
        </label>
        <Input
          id="control-token"
          name="control-token"
          type="password"
          autoComplete="current-password"
          autoFocus
          required
          value={token}
          aria-invalid={error === undefined ? undefined : true}
          aria-describedby={error === undefined ? undefined : "sign-in-error"}
          onChange={(event) => setToken(event.currentTarget.value)}
        />
        <Button type="submit" disabled={pending || token.length === 0}>
          {pending ? "Signing in…" : "Sign in"}
        </Button>
        {error === undefined ? null : (
          <p id="sign-in-error" role="alert" className="text-destructive text-sm">
            {error}
          </p>
        )}
      </form>
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
    <main className={page}>
      <header className="flex flex-col gap-2">
        <h1>pi-durable-replay</h1>
        <p className="text-muted-foreground">
          Replay failed durable agent runs without re-firing their tools, and kill runaway loops
          before they spend.
        </p>
      </header>
      <section
        aria-labelledby="create-session-heading"
        className="bg-card flex flex-col gap-3 rounded-xl border p-6 shadow-xs"
      >
        <h2 id="create-session-heading">Start a session</h2>
        <p className="text-muted-foreground text-sm">
          Create an isolated durable session and run the research agent.
        </p>
        <form onSubmit={createSession}>
          <Button type="submit" disabled={creating}>
            {creating ? "Creating session…" : "Create session"}
          </Button>
        </form>
        {error === undefined ? null : (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        )}
      </section>
    </main>
  );
}
