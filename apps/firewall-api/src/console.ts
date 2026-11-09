import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { DecisionRecord, POLICY_VERSION, type RuleBundle } from "@mwf/core";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { loadGraph } from "./store.js";

// The console (M9): a read-only view of one tenant's decisions, the rules and sensors deciding
// them, and the test battery's numbers. Data comes from /v1/console/* with the tenant's API key,
// so a tenant sees only its own decisions. The page itself (/console) is static and holds no
// data; it renders every value as text, never as HTML, because decisions quote attacker pages.

const PAGE_DIR = resolve(import.meta.dirname, "../console");
const PAGES: Record<string, { file: string; type: string }> = {
  "/console": { file: "index.html", type: "text/html; charset=utf-8" },
  "/console/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/console/style.css": { file: "style.css", type: "text/css; charset=utf-8" },
};

// The battery report the harness writes (npm run harness -- --json evidence/battery-report.json).
export const DEFAULT_REPORT = resolve(import.meta.dirname, "../../../evidence/battery-report.json");

const SECURITY_HEADERS = {
  "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};

// The static page. Public: it holds no data until the user gives it an API key.
export function consolePages(app: FastifyInstance) {
  app.get("/", async (_req, reply) => reply.redirect("/console"));
  app.get("/favicon.ico", async (_req, reply) => reply.code(204).send());
  for (const [url, page] of Object.entries(PAGES)) {
    app.get(url, async (_req, reply) => reply.headers({ ...SECURITY_HEADERS, "content-type": page.type }).send(readFileSync(join(PAGE_DIR, page.file))));
  }
}

const ListQuery = z.strictObject({
  after: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
const IdParams = z.strictObject({ id: z.uuid() });

type Row = { seq: number; payload: string };

// The tenant's console data. Registered inside /v1, so the API-key hook has already run.
export function consoleRoutes(v1: FastifyInstance, db: DatabaseSync, bundle: RuleBundle, tenantOf: (req: FastifyRequest) => string, reportPath = DEFAULT_REPORT) {
  const noStore = (reply: FastifyReply) => reply.header("cache-control", "no-store");
  const intents = new Map<string, string>();
  const intentOf = (tenantId: string, sessionId: string | null) => {
    if (!sessionId) return null;
    const key = `${tenantId}|${sessionId}`;
    if (!intents.has(key)) {
      const row = db.prepare("SELECT mandate FROM sessions WHERE id = ? AND tenant_id = ?").get(sessionId, tenantId) as { mandate: string } | undefined;
      intents.set(key, row ? (JSON.parse(row.mandate) as { intent_text: string }).intent_text : "");
    }
    return intents.get(key) ?? null;
  };

  // Newest first. `after`: only decisions newer than this ledger sequence number (the live feed).
  v1.get("/console/decisions", async (req, reply) => {
    const tenantId = tenantOf(req);
    const q = ListQuery.parse(req.query);
    const rows = db
      .prepare(
        "SELECT seq, payload FROM ledger WHERE kind = 'decision' AND json_extract(payload, '$.tenant_id') = ? AND seq > ? ORDER BY seq DESC LIMIT ?",
      )
      .all(tenantId, q.after ?? 0, q.limit) as Row[];
    const counts = db
      .prepare("SELECT decision, COUNT(*) AS n FROM decisions WHERE tenant_id = ? GROUP BY decision")
      .all(tenantId) as { decision: string; n: number }[];
    noStore(reply);
    return {
      totals: Object.fromEntries(counts.map((c) => [c.decision, c.n])),
      decisions: rows.map((r) => {
        const d = DecisionRecord.parse(JSON.parse(r.payload));
        return {
          seq: r.seq,
          id: d.id,
          created_at: d.created_at,
          checkpoint: d.checkpoint,
          decision: d.decision,
          session_id: d.session_id,
          intent: intentOf(tenantId, d.session_id),
          rule_ids: [...new Set(d.reasons.map((x) => x.rule_id))],
          shadow: (d.shadow_reasons ?? []).length,
        };
      }),
    };
  });

  // One decision with its attack path: the graph nodes from the attack point to the action.
  v1.get("/console/decisions/:id", async (req, reply) => {
    const tenantId = tenantOf(req);
    const { id } = IdParams.parse(req.params);
    const row = db
      .prepare("SELECT seq, payload FROM ledger WHERE kind = 'decision' AND json_extract(payload, '$.id') = ? AND json_extract(payload, '$.tenant_id') = ?")
      .get(id, tenantId) as Row | undefined;
    if (!row) return reply.code(404).send({ error: "not_found" });
    const d = DecisionRecord.parse(JSON.parse(row.payload));
    const graph = d.session_id && d.graph_path.length ? loadGraph(db, d.session_id) : null;
    const byId = new Map(graph?.nodes.map((n) => [n.id, n]) ?? []);
    noStore(reply);
    return {
      seq: row.seq,
      decision: d,
      intent: intentOf(tenantId, d.session_id),
      path: d.graph_path.map((n) => {
        const node = byId.get(n);
        return node ? { id: node.id, type: node.type, trust: node.trust ?? null, attrs: node.attrs } : { id: n, type: "unknown", trust: null, attrs: {} };
      }),
    };
  });

  // The rules deciding now: bundle and policy versions, learned rules and sensors with their
  // backtests. No tenant data; the same for every tenant.
  v1.get("/console/rules", async (_req, reply) => {
    noStore(reply);
    return {
      policy_version: POLICY_VERSION,
      rule_bundle_version: bundle.version,
      static_rules: bundle.text_rules.length + bundle.output_rules.length,
      claim_rules: bundle.claim_rules.map((r) => ({ id: r.id, description: r.description, state: r.state, phrases: r.phrases.length, fingerprints: r.fingerprints.length, families: r.learned.families.length, backtest: r.learned.backtest, approved_by: r.learned.approved_by, approved_at: r.learned.approved_at })),
      claim_sensors: bundle.claim_sensors.map((s) => ({ id: s.id, description: s.description, state: s.state, model: { name: s.model.name, sha256: s.model.sha256 }, threshold: s.threshold, calibration: s.learned.calibration, positives: s.learned.positives, negatives: s.learned.negatives, backtest: s.learned.backtest, approved_by: s.learned.approved_by, approved_at: s.learned.approved_at })),
    };
  });

  // The test battery's last report, as the harness wrote it.
  v1.get("/console/report", async (_req, reply) => {
    noStore(reply);
    if (!existsSync(reportPath)) return reply.code(404).send({ error: "no_report" });
    return JSON.parse(readFileSync(reportPath, "utf8")) as unknown;
  });
}
