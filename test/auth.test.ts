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

  it("opens a session WebSocket with the token as a query parameter", async () => {
    const response = await exports.default.fetch(
      `https://example.com/api/sessions/auth-test-session?token=${TOKEN}`,
      { headers: { Upgrade: "websocket" } },
    );
    expect(response.status).toBe(101);
    expect(response.webSocket).toBeDefined();
    response.webSocket!.accept();
    response.webSocket!.close(1000, "test complete");
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
