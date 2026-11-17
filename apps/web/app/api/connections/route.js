import { randomUUID } from "node:crypto";
import { getDatabase } from "../../../lib/database.js";
import {
  ApiError, handleApi, json, parseConnection, readJson, requireId,
  requireSameOrigin, requireUserId,
} from "../../../lib/api.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function rowToConnection(row) {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    endpoint: row.endpoint,
    notes: row.notes,
    updatedAt: row.updated_at,
  };
}

export async function GET(request) {
  return handleApi(async () => {
    const ownerId = await requireUserId(request);
    const rows = getDatabase().prepare(`
      SELECT id, name, kind, endpoint, notes, updated_at
      FROM agent_builder_connections WHERE owner_id = ? ORDER BY updated_at DESC, id ASC
    `).all(ownerId);
    return json({ connections: rows.map(rowToConnection) });
  });
}

export async function POST(request) {
  return handleApi(async () => {
    requireSameOrigin(request);
    const ownerId = await requireUserId(request);
    const connection = parseConnection(await readJson(request, 20_000));
    const id = "connection-" + randomUUID().replaceAll("-", "");
    const updatedAt = new Date().toISOString();
    const db = getDatabase();
    if (db.prepare("SELECT count(*) AS total FROM agent_builder_connections WHERE owner_id = ?").get(ownerId).total >= 50) {
      throw new ApiError(409, "An account can save at most 50 connection notes. Delete one before adding another.");
    }
    db.prepare(`
      INSERT INTO agent_builder_connections (owner_id, id, name, kind, endpoint, notes, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(ownerId, id, connection.name, connection.kind, connection.endpoint, connection.notes, updatedAt);
    return json({ connection: { id, ...connection, updatedAt } }, 201);
  });
}

export async function PATCH(request) {
  return handleApi(async () => {
    requireSameOrigin(request);
    const ownerId = await requireUserId(request);
    const connection = parseConnection(await readJson(request, 20_000), { update: true });
    const updatedAt = new Date().toISOString();
    const result = getDatabase().prepare(`
      UPDATE agent_builder_connections SET name = ?, kind = ?, endpoint = ?, notes = ?, updated_at = ?
      WHERE owner_id = ? AND id = ?
    `).run(connection.name, connection.kind, connection.endpoint, connection.notes, updatedAt, ownerId, connection.id);
    if (!result.changes) throw new ApiError(404, "Connection not found.");
    return json({ connection: { ...connection, updatedAt } });
  });
}

export async function DELETE(request) {
  return handleApi(async () => {
    requireSameOrigin(request);
    const ownerId = await requireUserId(request);
    const id = requireId(new URL(request.url).searchParams.get("id"));
    const result = getDatabase().prepare("DELETE FROM agent_builder_connections WHERE owner_id = ? AND id = ?").run(ownerId, id);
    if (!result.changes) throw new ApiError(404, "Connection not found.");
    return json({ ok: true });
  });
}
