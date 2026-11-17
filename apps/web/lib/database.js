import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";

let database;

/** One persistent SQLite database for Better Auth and owner-scoped app data. */
export function getDatabase() {
  if (database) return database;
  // Start Next from apps/web. In a packaged deployment, set the override to a
  // persistent absolute path; `process.cwd()` is more stable than a bundled URL.
  const filename = process.env.AGENT_BUILDER_DB_PATH
    ? path.resolve(/* turbopackIgnore: true */ process.env.AGENT_BUILDER_DB_PATH)
    : path.join(process.cwd(), ".data", "agent-builder.sqlite");
  mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(filename);
  chmodSync(filename, 0o600);
  db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_builder_agents (
      owner_id TEXT NOT NULL,
      id TEXT NOT NULL,
      name TEXT NOT NULL,
      agent_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (owner_id, id)
    );
    CREATE TABLE IF NOT EXISTS agent_builder_connections (
      owner_id TEXT NOT NULL,
      id TEXT NOT NULL,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      notes TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (owner_id, id)
    );
  `);
  database = db;
  return db;
}
