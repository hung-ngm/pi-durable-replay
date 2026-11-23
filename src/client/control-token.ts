export async function isSignedIn(): Promise<boolean> {
  return (await fetch("/api/auth")).ok;
}

export async function signIn(token: string): Promise<"accepted" | "rejected"> {
  const response = await fetch("/api/auth", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  if (response.ok) return "accepted";
  if (response.status === 401) return "rejected";
  throw new Error(`Sign-in failed (${response.status})`);
}
