let signedIn: Promise<void> | undefined;

/**
 * Sign the browser in once (SPEC Q8). The Worker answers a correct token with an
 * HttpOnly cookie, so every tab and the session WebSocket share one sign-in and the
 * token itself never sits in page storage or a URL. Concurrent callers share one prompt.
 */
export function ensureSignedIn(): Promise<void> {
  signedIn ??= signIn().catch((error: unknown) => {
    signedIn = undefined;
    throw error;
  });
  return signedIn;
}

async function signIn(): Promise<void> {
  if ((await fetch("/api/auth")).ok) return;
  let message = "Control token";
  for (;;) {
    const token = window.prompt(message);
    if (token === null) throw new Error("A control token is required");
    const response = await fetch("/api/auth", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    if (response.ok) return;
    message = "That control token was wrong. Control token";
  }
}
