import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAgent } from "../../../packages/agent-builder-core/index.js";

const BASE = "http://127.0.0.1:18882";

test("authenticated agents and non-secret connection notes stay owner scoped", async () => {
  const folder = mkdtempSync(path.join(os.tmpdir(), "agent-builder-api-"));
  process.env.AGENT_BUILDER_DB_PATH = path.join(folder, "app.sqlite");
  process.env.BETTER_AUTH_URL = BASE;
  process.env.BETTER_AUTH_SECRET = "test-only-secret-value-with-more-than-32-bytes";

  try {
    const { getReadyAuth } = await import("./auth.js");
    const agents = await import("../app/api/agents/route.js");
    const connections = await import("../app/api/connections/route.js");
    const auth = await getReadyAuth();

    async function signUp(email) {
      const response = await auth.handler(new Request(BASE + "/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE, "x-forwarded-for": "127.0.0.1" },
        body: JSON.stringify({ name: "Test User", email, password: "a-long-test-password" }),
      }));
      assert.equal(response.status, 200, await response.text());
      return response.headers.get("set-cookie").split(";")[0];
    }

    const ownerCookie = await signUp("owner@example.com");
    const otherCookie = await signUp("other@example.com");
    const request = (route, method, cookie, body, origin = BASE) => new Request(BASE + route, {
      method,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(method !== "GET" ? { origin } : {}),
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    assert.equal((await agents.GET(request("/api/agents", "GET"))).status, 401);
    const agent = { ...createAgent("blank"), name: "Private planner", instructions: "Use only the notes I provide." };
    const saved = await agents.PUT(request("/api/agents", "PUT", ownerCookie, { agent }));
    assert.equal(saved.status, 200, await saved.text());
    const savedRow = (await agents.GET(request("/api/agents", "GET", ownerCookie))).json();
    assert.equal((await savedRow).agents[0].id, agent.id);
    assert.deepEqual((await (await agents.GET(request("/api/agents", "GET", otherCookie))).json()).agents, []);
    assert.equal((await agents.DELETE(request("/api/agents?id=" + agent.id, "DELETE", otherCookie))).status, 404);
    assert.equal((await agents.PUT(request("/api/agents", "PUT", ownerCookie, { agent }, "https://elsewhere.example"))).status, 403);
    assert.equal((await agents.PUT(request("/api/agents", "PUT", ownerCookie, { agent: { ...agent, apiKey: "sk-test-secret" } }))).status, 400);

    const connectionBody = { name: "Work GitHub", kind: "github", endpoint: "https://github.com/example", notes: "Approve locally." };
    const created = await connections.POST(request("/api/connections", "POST", ownerCookie, connectionBody));
    assert.equal(created.status, 201);
    const { connection } = await created.json();
    assert.equal(connection.kind, "github");
    assert.deepEqual((await (await connections.GET(request("/api/connections", "GET", otherCookie))).json()).connections, []);
    assert.equal((await connections.PATCH(request("/api/connections", "PATCH", otherCookie, { ...connectionBody, id: connection.id }))).status, 404);
    assert.equal((await connections.POST(request("/api/connections", "POST", ownerCookie, { ...connectionBody, notes: "api_key=secret-value" }))).status, 400);
    assert.equal((await connections.DELETE(request("/api/connections?id=" + connection.id, "DELETE", ownerCookie))).status, 200);
    assert.equal((await agents.DELETE(request("/api/agents?id=" + agent.id, "DELETE", ownerCookie))).status, 200);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
