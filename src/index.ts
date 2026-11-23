export { Session } from "./session.ts";

const json = (body: unknown, status: number, headers?: HeadersInit): Response =>
  Response.json(body, { status, headers });

const sessionSocketRoute = /^\/api\/sessions\/([^/]+)\/?$/;

const AUTH_COOKIE = "pdr_control";
const AUTH_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const encoder = new TextEncoder();

/** Constant-time secret comparison: hash both sides to a fixed size, then compare. */
async function sameSecret(a: string, b: string): Promise<boolean> {
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(left, right);
}

/** The cookie carries a digest of the token, never the token itself. */
async function cookieValue(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(`pdr-control:${token}`));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function readCookie(request: Request, name: string): string | undefined {
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return undefined;
}

/**
 * Single-user auth (SPEC Q8), from the CONTROL_TOKEN secret. Scripts send
 * `Authorization: Bearer <token>`. Browsers sign in once at POST /api/auth and get an
 * HttpOnly cookie, which every tab and the WebSocket upgrade send automatically.
 * When CONTROL_TOKEN is not configured (local development without .dev.vars), the
 * API is open; a deployment must always set the secret (see README).
 */
async function authorized(request: Request, env: Env): Promise<boolean> {
  const token = env.CONTROL_TOKEN;
  if (token === undefined || token === "") return true;
  const header = request.headers.get("Authorization");
  if (header?.startsWith("Bearer ") && (await sameSecret(header.slice(7), token))) return true;
  const cookie = readCookie(request, AUTH_COOKIE);
  return cookie !== undefined && (await sameSecret(cookie, await cookieValue(token)));
}

async function signIn(request: Request, env: Env): Promise<Response> {
  const token = env.CONTROL_TOKEN;
  if (token === undefined || token === "") return new Response(null, { status: 204 });
  let submitted: unknown;
  try {
    submitted = ((await request.json()) as { token?: unknown }).token;
  } catch {
    return json({ error: "Expected a JSON body with a token" }, 400);
  }
  if (typeof submitted !== "string" || !(await sameSecret(submitted, token))) return unauthorized();
  const cookie =
    `${AUTH_COOKIE}=${await cookieValue(token)}; Path=/api; HttpOnly; Secure; ` +
    `SameSite=Strict; Max-Age=${AUTH_COOKIE_MAX_AGE_SECONDS}`;
  return new Response(null, { status: 204, headers: { "Set-Cookie": cookie } });
}

const unauthorized = (): Response =>
  json({ error: "Unauthorized" }, 401, { "WWW-Authenticate": "Bearer" });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/auth") {
      if (request.method === "POST") return signIn(request, env);
      if (request.method === "GET") {
        return (await authorized(request, env))
          ? new Response(null, { status: 204 })
          : unauthorized();
      }
      return json({ error: "Method not allowed" }, 405, { Allow: "GET, POST" });
    }

    if (url.pathname === "/api/sessions" || url.pathname === "/api/sessions/") {
      if (request.method !== "POST") {
        return json({ error: "Method not allowed" }, 405, { Allow: "POST" });
      }
      if (!(await authorized(request, env))) return unauthorized();
      const sessionId = crypto.randomUUID();
      return json({ sessionId, url: `/sessions/${sessionId}` }, 201);
    }

    const sessionMatch = sessionSocketRoute.exec(url.pathname);
    if (sessionMatch !== null) {
      if (request.method !== "GET") {
        return json({ error: "Method not allowed" }, 405, { Allow: "GET" });
      }
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return json({ error: "WebSocket upgrade required" }, 426, { Upgrade: "websocket" });
      }
      if (!(await authorized(request, env))) return unauthorized();
      return env.SESSIONS.getByName(sessionMatch[1]).fetch(request);
    }

    return json({ error: "Not found" }, 404);
  },
} satisfies ExportedHandler<Env>;
