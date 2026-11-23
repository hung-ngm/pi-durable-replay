import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

// CONTROL_TOKEN is bound to "test-control-token" in vitest.config.ts.
const TOKEN = "test-control-token";

describe("bearer auth at the Worker seam", () => {
  it("rejects session creation without a token", async () => {
    const response = await exports.default.fetch("https://example.com/api/sessions", {
      method: "POST",
    });
    expect(response.status).toBe(401);
  });

  it("rejects session creation with a wrong token", async () => {
    const response = await exports.default.fetch("https://example.com/api/sessions", {
      method: "POST",
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(response.status).toBe(401);
  });

  it("creates a session with the token", async () => {
    const response = await exports.default.fetch("https://example.com/api/sessions", {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status).toBe(201);
    const result = await response.json<{ sessionId: string; url: string }>();
    expect(result.url).toBe(`/sessions/${result.sessionId}`);
  });

  it("rejects a session WebSocket without a token", async () => {
    const response = await exports.default.fetch(
      "https://example.com/api/sessions/auth-test-session",
      { headers: { Upgrade: "websocket" } },
    );
    expect(response.status).toBe(401);
  });

  it("no longer accepts the token as a query parameter", async () => {
    const response = await exports.default.fetch(
      `https://example.com/api/sessions/auth-test-session?token=${TOKEN}`,
      { headers: { Upgrade: "websocket" } },
    );
    expect(response.status).toBe(401);
  });

  it("opens a session WebSocket with the token as a header", async () => {
    const response = await exports.default.fetch(
      "https://example.com/api/sessions/auth-test-session-2",
      { headers: { Upgrade: "websocket", Authorization: `Bearer ${TOKEN}` } },
    );
    expect(response.status).toBe(101);
    response.webSocket!.accept();
    response.webSocket!.close(1000, "test complete");
  });
});

async function signIn(token: string): Promise<Response> {
  return exports.default.fetch("https://example.com/api/auth", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
}

describe("cookie sign-in shared by every tab", () => {
  it("rejects a wrong token and sets no cookie", async () => {
    const response = await signIn("wrong-token");
    expect(response.status).toBe(401);
    expect(response.headers.get("Set-Cookie")).toBeNull();
  });

  it("reports signed out without a cookie", async () => {
    const response = await exports.default.fetch("https://example.com/api/auth");
    expect(response.status).toBe(401);
  });

  it("sets an HttpOnly, Secure, SameSite=Strict cookie that never holds the raw token", async () => {
    const response = await signIn(TOKEN);
    expect(response.status).toBe(204);
    const cookie = response.headers.get("Set-Cookie") ?? "";
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(cookie).not.toContain(TOKEN);
  });

  it("authorizes the status check, session creation, and the socket with the cookie alone", async () => {
    const cookie = ((await signIn(TOKEN)).headers.get("Set-Cookie") ?? "").split(";")[0];

    const status = await exports.default.fetch("https://example.com/api/auth", {
      headers: { Cookie: cookie },
    });
    expect(status.status).toBe(204);

    const created = await exports.default.fetch("https://example.com/api/sessions", {
      method: "POST",
      headers: { Cookie: cookie },
    });
    expect(created.status).toBe(201);

    const socket = await exports.default.fetch(
      "https://example.com/api/sessions/auth-test-cookie",
      { headers: { Upgrade: "websocket", Cookie: cookie } },
    );
    expect(socket.status).toBe(101);
    socket.webSocket!.accept();
    socket.webSocket!.close(1000, "test complete");
  });

  it("rejects a forged cookie", async () => {
    const response = await exports.default.fetch("https://example.com/api/sessions", {
      method: "POST",
      headers: { Cookie: `pdr_control=${TOKEN}` },
    });
    expect(response.status).toBe(401);
  });
});
