export { Session } from "./session.ts";

const json = (body: unknown, status: number, headers?: HeadersInit): Response =>
  Response.json(body, { status, headers });

const sessionSocketRoute = /^\/api\/sessions\/([^/]+)\/?$/;

/**
 * Single-user bearer auth (SPEC Q8). The token comes from the CONTROL_TOKEN secret.
 * Browsers cannot set headers on a WebSocket, so the socket route also accepts the
 * token as a `token` query parameter; HTTP calls use the Authorization header.
 * When CONTROL_TOKEN is not configured (local development without .dev.vars), the
 * API is open; a deployment must always set the secret (see README).
 */
function authorized(request: Request, url: URL, env: Env): boolean {
  const token = env.CONTROL_TOKEN;
  if (token === undefined || token === "") return true;
  const header = request.headers.get("Authorization");
  if (header === `Bearer ${token}`) return true;
  return url.searchParams.get("token") === token;
}

const unauthorized = (): Response =>
  json({ error: "Unauthorized" }, 401, { "WWW-Authenticate": "Bearer" });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/sessions" || url.pathname === "/api/sessions/") {
      if (request.method !== "POST") {
        return json({ error: "Method not allowed" }, 405, { Allow: "POST" });
      }
      if (!authorized(request, url, env)) return unauthorized();
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
      if (!authorized(request, url, env)) return unauthorized();
      return env.SESSIONS.getByName(sessionMatch[1]).fetch(request);
    }

    return json({ error: "Not found" }, 404);
  },
} satisfies ExportedHandler<Env>;
