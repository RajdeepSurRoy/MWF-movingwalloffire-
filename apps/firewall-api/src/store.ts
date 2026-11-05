import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type Graph, type GraphNode, MAX_PATH_EDGES, PATH_EDGES, type TaintPath, selectPaths } from "@mwf/core";

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

    -- The session's provenance graph (architecture §6). Append-only, like context_log: a node
    -- or edge, once recorded, stays.
    CREATE TABLE IF NOT EXISTS graph_nodes (
      session_id TEXT NOT NULL REFERENCES sessions (id),
      id         TEXT NOT NULL,
      type       TEXT NOT NULL,
      trust      TEXT,
      attrs      TEXT NOT NULL,
      PRIMARY KEY (session_id, id)
    );
    CREATE TABLE IF NOT EXISTS graph_edges (
      session_id TEXT NOT NULL REFERENCES sessions (id),
      src        TEXT NOT NULL,
      dst        TEXT NOT NULL,
      type       TEXT NOT NULL,
      PRIMARY KEY (session_id, src, dst, type)
    );
    CREATE INDEX IF NOT EXISTS graph_edges_dst ON graph_edges (session_id, dst);
    CREATE TRIGGER IF NOT EXISTS graph_nodes_no_update BEFORE UPDATE ON graph_nodes
      BEGIN SELECT RAISE(ABORT, 'graph_nodes is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS graph_edges_no_update BEFORE UPDATE ON graph_edges
      BEGIN SELECT RAISE(ABORT, 'graph_edges is append-only'); END;

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
  // Headless-browser view of an HTML item (RenderReport JSON); NULL when it was not rendered.
  addColumnIfMissing(db, "context_log", "render", "TEXT");
  return db;
}

export function upsertMerchant(db: DatabaseSync, tenantId: string, merchant: { id: string; name: string; payee_emails: string[] }) {
  db.prepare(
    "INSERT INTO merchants (tenant_id, merchant_id, name, payee_emails) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT (tenant_id, merchant_id) DO UPDATE SET name = excluded.name, payee_emails = excluded.payee_emails",
  ).run(tenantId, merchant.id, merchant.name, JSON.stringify(merchant.payee_emails));
}

export function saveGraph(db: DatabaseSync, sessionId: string, graph: Graph) {
  const node = db.prepare("INSERT OR IGNORE INTO graph_nodes (session_id, id, type, trust, attrs) VALUES (?, ?, ?, ?, ?)");
  const edge = db.prepare("INSERT OR IGNORE INTO graph_edges (session_id, src, dst, type) VALUES (?, ?, ?, ?)");
  db.exec("BEGIN");
  try {
    for (const n of graph.nodes) node.run(sessionId, n.id, n.type, n.trust ?? null, JSON.stringify(n.attrs));
    for (const e of graph.edges) edge.run(sessionId, e.src, e.dst, e.type);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function loadGraph(db: DatabaseSync, sessionId: string): Graph {
  const nodes = (db.prepare("SELECT id, type, trust, attrs FROM graph_nodes WHERE session_id = ?").all(sessionId) as {
    id: string;
    type: GraphNode["type"];
    trust: GraphNode["trust"] | null;
    attrs: string;
  }[]).map((r) => ({ id: r.id, type: r.type, ...(r.trust && { trust: r.trust }), attrs: JSON.parse(r.attrs) as Record<string, unknown> }));
  const edges = db.prepare("SELECT src, dst, type FROM graph_edges WHERE session_id = ?").all(sessionId) as unknown as Graph["edges"];
  return { nodes, edges };
}

// The path query over the stored graph, as a recursive CTE: every simple path of at most
// MAX_PATH_EDGES edges from a node carrying a signal to `target`. selectPaths then keeps one
// per origin, exactly as taintPaths does in memory. CROSS JOIN fixes the join order so each
// step looks edges up by (session_id, src); left to the planner it scanned the session's edges
// for every row (22 ms instead of under 1 ms on a demo-size session).
export function queryTaintPaths(db: DatabaseSync, sessionId: string, target: string): TaintPath[] {
  const edgeTypes = PATH_EDGES.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `WITH RECURSIVE walk (node, path, depth) AS (
         SELECT id, json_array(id), 0 FROM graph_nodes
          WHERE session_id = ? AND type IN ('source', 'span') AND json_extract(attrs, '$.signal') IN ('hard', 'soft')
         UNION ALL
         SELECT e.dst, json_insert(w.path, '$[#]', e.dst), w.depth + 1
           FROM walk w CROSS JOIN graph_edges e ON e.session_id = ? AND e.src = w.node
          WHERE w.depth < ? AND w.node <> ? AND e.type IN (${edgeTypes})
            AND NOT EXISTS (SELECT 1 FROM json_each(w.path) WHERE json_each.value = e.dst)
       )
       SELECT path FROM walk WHERE node = ?`,
    )
    .all(sessionId, sessionId, MAX_PATH_EDGES, target, ...PATH_EDGES, target) as { path: string }[];
  const candidates = rows.map((r) => JSON.parse(r.path) as string[]);
  // Only the nodes on candidate paths are needed to rank them.
  const ids = [...new Set(candidates.flat())];
  const nodes = ids.length
    ? (db
        .prepare(`SELECT id, type, attrs FROM graph_nodes WHERE session_id = ? AND id IN (SELECT value FROM json_each(?))`)
        .all(sessionId, JSON.stringify(ids)) as { id: string; type: GraphNode["type"]; attrs: string }[]).map((r) => ({
        id: r.id,
        type: r.type,
        attrs: JSON.parse(r.attrs) as Record<string, unknown>,
      }))
    : [];
  return selectPaths(candidates, { nodes, edges: [] });
}
