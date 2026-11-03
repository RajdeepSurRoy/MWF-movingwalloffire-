import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

// Databases created before a column existed get it added on open.
function addColumnIfMissing(db: DatabaseSync, table: string, column: string, definition: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

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

    -- The business's merchant registry: which payees each merchant id may be paid at.
    CREATE TABLE IF NOT EXISTS merchants (
      tenant_id    TEXT NOT NULL,
      merchant_id  TEXT NOT NULL,
      name         TEXT NOT NULL,
      payee_emails TEXT NOT NULL,
      PRIMARY KEY (tenant_id, merchant_id)
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

    -- Append-only: re-sending an item id with new content adds a version, never replaces one,
    -- so an attacker cannot wash a quarantined page by re-inspecting it with clean content.
    -- (Replaces the M1 context_items table, which is no longer read.)
    CREATE TABLE IF NOT EXISTS context_log (
      seq          INTEGER PRIMARY KEY,
      session_id   TEXT    NOT NULL REFERENCES sessions (id),
      item_id      TEXT    NOT NULL,
      trust        TEXT    NOT NULL,
      content_hash TEXT    NOT NULL,
      item         TEXT    NOT NULL,
      quarantined  INTEGER NOT NULL,
      created_at   TEXT    NOT NULL,
      UNIQUE (session_id, item_id, content_hash)
    );
    CREATE TRIGGER IF NOT EXISTS context_log_no_update BEFORE UPDATE ON context_log
      BEGIN SELECT RAISE(ABORT, 'context_log is append-only'); END;

    -- Issued only on ALLOW; bound to the hash of the exact approved action; single use.
    CREATE TABLE IF NOT EXISTS action_tokens (
      token_hash   TEXT PRIMARY KEY,
      session_id   TEXT NOT NULL REFERENCES sessions (id),
      action_hash  TEXT NOT NULL,
      created_at   TEXT NOT NULL,
      committed_at TEXT
    );

    -- Index of ledger decisions, so feedback can be checked against the caller's tenant.
    CREATE TABLE IF NOT EXISTS decisions (
      id         TEXT PRIMARY KEY,
      tenant_id  TEXT NOT NULL,
      session_id TEXT,
      checkpoint TEXT NOT NULL,
      decision   TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  addColumnIfMissing(db, "sessions", "canary", "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, "sessions", "risk_score", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "context_items", "quarantined", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "action_tokens", "expires_at", "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, "action_tokens", "idempotency_key", "TEXT NOT NULL DEFAULT ''");
  return db;
}

export function upsertMerchant(db: DatabaseSync, tenantId: string, merchant: { id: string; name: string; payee_emails: string[] }) {
  db.prepare(
    "INSERT INTO merchants (tenant_id, merchant_id, name, payee_emails) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT (tenant_id, merchant_id) DO UPDATE SET name = excluded.name, payee_emails = excluded.payee_emails",
  ).run(tenantId, merchant.id, merchant.name, JSON.stringify(merchant.payee_emails));
}
