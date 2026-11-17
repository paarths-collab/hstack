import { parseAgentJson } from "../../../../../packages/agent-builder-core/index.js";
import { getDatabase } from "../../../lib/database.js";
import {
  ApiError, handleApi, json, readJson, requireExactFields, requireId,
  requireSameOrigin, requireUserId,
} from "../../../lib/api.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request) {
  return handleApi(async () => {
    const ownerId = await requireUserId(request);
    const rows = getDatabase().prepare(`
      SELECT id, name, agent_json, updated_at
      FROM agent_builder_agents WHERE owner_id = ? ORDER BY updated_at DESC, id ASC
    `).all(ownerId);
    return json({ agents: rows.map((row) => ({
      id: row.id, name: row.name, agent: JSON.parse(row.agent_json), updatedAt: row.updated_at,
    })) });
  });
}

export async function PUT(request) {
  return handleApi(async () => {
    requireSameOrigin(request);
    const ownerId = await requireUserId(request);
    const body = await readJson(request);
    requireExactFields(body, ["agent"]);
    let agent;
    try { agent = parseAgentJson(JSON.stringify(body.agent)); }
    catch (error) { throw new ApiError(400, error instanceof Error ? error.message : "Agent configuration is invalid."); }
    const updatedAt = new Date().toISOString();
    const db = getDatabase();
    const alreadySaved = db.prepare("SELECT 1 FROM agent_builder_agents WHERE owner_id = ? AND id = ?").get(ownerId, agent.id);
    if (!alreadySaved && db.prepare("SELECT count(*) AS total FROM agent_builder_agents WHERE owner_id = ?").get(ownerId).total >= 50) {
      throw new ApiError(409, "An account can save at most 50 agents. Delete one before adding another.");
    }
    db.prepare(`
      INSERT INTO agent_builder_agents (owner_id, id, name, agent_json, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(owner_id, id) DO UPDATE SET
        name = excluded.name, agent_json = excluded.agent_json, updated_at = excluded.updated_at
    `).run(ownerId, agent.id, agent.name, JSON.stringify(agent), updatedAt);
    return json({ agent: { id: agent.id, name: agent.name, agent, updatedAt } });
  });
}

export async function DELETE(request) {
  return handleApi(async () => {
    requireSameOrigin(request);
    const ownerId = await requireUserId(request);
    const id = requireId(new URL(request.url).searchParams.get("id"));
    const result = getDatabase().prepare("DELETE FROM agent_builder_agents WHERE owner_id = ? AND id = ?").run(ownerId, id);
    if (!result.changes) throw new ApiError(404, "Agent not found.");
    return json({ ok: true });
  });
}
