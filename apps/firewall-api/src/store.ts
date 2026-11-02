import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

// One SQLite file per firewall instance. ":memory:" is used by tests.
export function openDatabase(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS api_keys (
      id          TEXT PRIMARY KEY,
      tenant_id   TEXT NOT NULL,
      key_hash    TEXT NOT NULL UNIQUE,
      key_prefix  TEXT NOT NULL,
      label       TEXT NOT NULL,
      created_at  TEXT NOT NULL,
      revoked_at  TEXT
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id           TEXT PRIMARY KEY,
      tenant_id    TEXT NOT NULL,
      prompt       TEXT NOT NULL,
      mandate      TEXT NOT NULL,
      mandate_hash TEXT NOT NULL,
      created_at   TEXT NOT NULL,
      expires_at   TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_tenant ON sessions (tenant_id, id);

    CREATE TABLE IF NOT EXISTS context_items (
      session_id   TEXT NOT NULL REFERENCES sessions (id),
      item_id      TEXT NOT NULL,
      trust        TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      item         TEXT NOT NULL,
      created_at   TEXT NOT NULL,
      PRIMARY KEY (session_id, item_id)
    );

    -- Issued only on ALLOW (M2); bound to the hash of the exact approved action.
    CREATE TABLE IF NOT EXISTS action_tokens (
      token_hash   TEXT PRIMARY KEY,
      session_id   TEXT NOT NULL REFERENCES sessions (id),
      action_hash  TEXT NOT NULL,
      created_at   TEXT NOT NULL,
      committed_at TEXT
    );
  `);
  return db;
}
