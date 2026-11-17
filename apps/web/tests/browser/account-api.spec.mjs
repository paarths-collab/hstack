import { request as requestFactory, test, expect } from "@playwright/test";
import { createAgent } from "../../../../packages/agent-builder-core/index.js";

const origin = "http://127.0.0.1:18882";
const password = "A-long-test-only-passphrase-2026!";

async function client() {
  return requestFactory.newContext({ baseURL: origin, extraHTTPHeaders: { Origin: origin } });
}

async function createAccount(api, name) {
  const email = `${name.toLowerCase()}-${crypto.randomUUID()}@example.test`;
  const response = await api.post("/api/auth/sign-up/email", {
    data: { name, email, password },
  });
  expect(response.status(), await response.text()).toBe(200);
  return email;
}

test("account APIs isolate saved agents and editable app configurations", async () => {
  const guest = await client();
  const alice = await client();
  const bob = await client();
  const foreignOrigin = await requestFactory.newContext({ baseURL: origin, extraHTTPHeaders: { Origin: "https://example.org" } });
  try {
    expect((await guest.get("/api/agents")).status()).toBe(401);
    expect((await guest.get("/api/connections")).status()).toBe(401);

    await createAccount(alice, "Alice");
    const agent = createAgent("research");
    agent.name = "Alice's research agent";
    agent.workflows[0].name = "Edited research digest";
    const saved = await alice.put("/api/agents", { data: { agent } });
    expect(saved.status(), await saved.text()).toBe(200);
    expect((await saved.json()).agent.id).toBe(agent.id);
    expect((await foreignOrigin.put("/api/agents", { data: { agent } })).status()).toBe(403);

    const connection = await alice.post("/api/connections", {
      data: {
        name: "Research GitHub",
        kind: "github",
        endpoint: "https://github.com/example/research",
        notes: "Review read access in the local harness.",
      },
    });
    expect(connection.status(), await connection.text()).toBe(201);
    const connectionId = (await connection.json()).connection.id;
    const edited = await alice.patch("/api/connections", {
      data: {
        id: connectionId,
        name: "Research GitHub",
        kind: "github",
        endpoint: "https://github.com/example/research",
        notes: "Use only for the approved repository.",
      },
    });
    expect(edited.status(), await edited.text()).toBe(200);
    expect((await edited.json()).connection.notes).toBe("Use only for the approved repository.");

    const rejectedSecret = await alice.post("/api/connections", {
      data: {
        name: "Unsafe",
        kind: "custom",
        endpoint: "",
        notes: "ghp_abcdefghijklmnopqrstuvwxyz123456",
      },
    });
    expect(rejectedSecret.status()).toBe(400);

    await createAccount(bob, "Bob");
    expect((await (await bob.get("/api/agents")).json()).agents).toEqual([]);
    expect((await (await bob.get("/api/connections")).json()).connections).toEqual([]);
    expect((await bob.delete(`/api/agents?id=${agent.id}`)).status()).toBe(404);
    expect((await bob.delete(`/api/connections?id=${connectionId}`)).status()).toBe(404);
    expect((await bob.patch("/api/connections", {
      data: {
        id: connectionId,
        name: "Cannot change this",
        kind: "github",
        endpoint: "",
        notes: "",
      },
    })).status()).toBe(404);

    const aliceAgents = (await (await alice.get("/api/agents")).json()).agents;
    expect(aliceAgents).toHaveLength(1);
    expect(aliceAgents[0].agent.workflows[0].name).toBe("Edited research digest");
    const aliceConnections = (await (await alice.get("/api/connections")).json()).connections;
    expect(aliceConnections).toHaveLength(1);
    expect(aliceConnections[0].notes).toBe("Use only for the approved repository.");
  } finally {
    await Promise.all([guest.dispose(), alice.dispose(), bob.dispose(), foreignOrigin.dispose()]);
  }
});
