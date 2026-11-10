import { randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { z } from "zod";
import {
  type Checkpoint,
  ContextItem,
  DEFAULT_DECISION,
  type DecisionRecord,
  type EngineResult,
  Ledger,
  Mandate,
  type MerchantRecord,
  POLICY_VERSION,
  PaymentArgs,
  PreparedEffect,
  ProposedAction,
  RenderReport,
  type RenderReports,
  type RuleBundle,
  checkAction,
  checkCommit,
  checkContext,
  checkIntent,
  checkOutput,
  getDefaultBundle,
  sensorTexts,
  type SensorVectors,
  hashCanonical,
  intentGraph,
  toCents,
} from "@mwf/core";
import { authenticate } from "./auth.js";
import { openDatabase, saveGraph } from "./store.js";
import { DEFAULT_REPORT, consolePages, consoleRoutes } from "./console.js";

declare module "fastify" {
  interface FastifyRequest {
    tenantId: string;
  }
}

const SessionId = z.uuid();

const CreateSessionBody = z.strictObject({ prompt: z.string().min(1).max(10_000), mandate: Mandate });
const InspectContextBody = z.strictObject({ session_id: SessionId, items: z.array(ContextItem).min(1).max(100) });
const CheckActionBody = z.strictObject({ session_id: SessionId, action: ProposedAction });
const CommitActionBody = z.strictObject({
  session_id: SessionId,
  action_token: z.string().min(1).max(200),
  action: ProposedAction,
  // Two-phase commit: what the outside system has prepared, as it reports it (see PreparedEffect).
  prepared: PreparedEffect.optional(),
});
const OutcomeBody = z.strictObject({
  session_id: SessionId,
  system: PreparedEffect.shape.system,
  reference: PreparedEffect.shape.reference,
  outcome: z.enum(["executed", "cancelled", "held"]),
  // The system's own status and ids for what happened (e.g. a capture id), for the evidence trail.
  status: z.string().min(1).max(60),
  external_ids: PreparedEffect.shape.external_ids,
});
const ReleaseActionBody = z.strictObject({ session_id: SessionId, action_token: z.string().min(1).max(200) });
// A person's answer to a REVIEW, collected by the integration in its own UI (never by the model).
const ReviewActionBody = z.strictObject({
  session_id: SessionId,
  review_token: z.string().min(1).max(200),
  verdict: z.enum(["approve", "reject"]),
  // Who answered: the end user the agent works for, or the integrating business's own staff.
  reviewer: z.enum(["end_user", "operator"]),
  note: z.string().max(2000).optional(),
});
const CheckOutputBody = z.strictObject({
  session_id: SessionId,
  output: z.strictObject({ content: z.string().max(500_000), destination: z.string().max(2000).optional() }),
});
const FeedbackBody = z.strictObject({
  session_id: SessionId.optional(),
  decision_id: z.uuid().optional(),
  kind: z.enum(["dispute", "chargeback", "reviewer_verdict", "user_report", "false_positive"]),
  verdict: z.enum(["ALLOW", "BLOCK"]).optional(),
  note: z.string().max(5000).optional(),
});

class NotFound extends Error {}

const secret = (prefix: string) => prefix + randomBytes(32).toString("base64url");

// Renders an HTML context item in a headless browser (see @mwf/render). Must not throw;
// failures are reports with ok: false. Without one, pages get the static visibility check only.
export type Render = (item: ContextItem) => Promise<RenderReport>;

// Embeds claim texts for the bundle's embedding sensors (see @mwf/sensors). Must not throw; texts
// it could not embed are left out, and an enforced sensor then holds the claim for REVIEW.
export type Embed = (texts: string[]) => Promise<SensorVectors>;

export function buildApp({
  db = openDatabase(":memory:"),
  bundle = getDefaultBundle(),
  render,
  embed,
  reportPath = DEFAULT_REPORT,
}: { db?: DatabaseSync; bundle?: RuleBundle; render?: Render; embed?: Embed; reportPath?: string } = {}) {
  const app = Fastify({ logger: false, bodyLimit: 1_048_576 });
  const ledger = new Ledger(db);

  app.decorateRequest("tenantId", "");

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof z.ZodError) return reply.code(400).send({ error: "invalid_request", issues: err.issues });
    if (err instanceof NotFound) return reply.code(404).send({ error: "not_found" });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) return reply.code(status).send({ error: "bad_request" });
    // Never leak internals. The client must treat this as "not allowed".
    return reply.code(500).send({ error: "internal", decision: DEFAULT_DECISION });
  });

  app.get("/healthz", async () => ({ ok: true, failClosedDecision: DEFAULT_DECISION, ruleBundle: bundle.version }));

  // Every /v1 route lives in this plugin, so its auth hook applies to the matched routes
  // whatever the URL encoding. Routes outside it (only /healthz) are public.
  app.register(async (v1) => v1Routes(v1, db, ledger, bundle, render, embed, reportPath), { prefix: "/v1" });
  // The console page (static, no data); its data is under /v1/console with the tenant's key.
  consolePages(app);

  return app;
}

function v1Routes(v1: FastifyInstance, db: DatabaseSync, ledger: Ledger, bundle: RuleBundle, render: Render | undefined, embed: Embed | undefined, reportPath: string) {
  v1.addHook("onRequest", async (req, reply) => {
    const tenant = authenticate(db, req.headers.authorization);
    if (!tenant) return reply.code(401).send({ error: "unauthorized" });
    req.tenantId = tenant;
  });

  // Defence in depth: a handler never runs without a tenant.
  const tenantOf = (req: FastifyRequest) => {
    if (!req.tenantId) throw Object.assign(new Error("unauthenticated"), { statusCode: 401 });
    return req.tenantId;
  };
  consoleRoutes(v1, db, bundle, tenantOf, reportPath);

  function loadSession(tenantId: string, sessionId: string) {
    const row = db.prepare("SELECT mandate, canary, risk_score FROM sessions WHERE id = ? AND tenant_id = ?").get(sessionId, tenantId) as
      | { mandate: string; canary: string; risk_score: number }
      | undefined;
    if (!row) throw new NotFound();
    return { mandate: Mandate.parse(JSON.parse(row.mandate)), canaries: row.canary ? [row.canary] : [], risk: row.risk_score };
  }

  // Every version of every item the session has seen, plus the ids ever quarantined.
  function loadContext(sessionId: string): { items: ContextItem[]; quarantined: string[]; renders: RenderReports } {
    const rows = db
      .prepare("SELECT item, item_id, content_hash, quarantined, render FROM context_log WHERE session_id = ? ORDER BY seq")
      .all(sessionId) as { item: string; item_id: string; content_hash: string; quarantined: number; render: string | null }[];
    const renders: RenderReports = {};
    for (const r of rows) if (r.render) renders[r.content_hash] = RenderReport.parse(JSON.parse(r.render));
    return {
      items: rows.map((r) => ContextItem.parse(JSON.parse(r.item))),
      quarantined: [...new Set(rows.filter((r) => r.quarantined).map((r) => r.item_id))],
      renders,
    };
  }

  // Renders untrusted HTML items, keyed by item hash. Trusted and non-HTML items are not rendered.
  async function renderItems(items: ContextItem[]): Promise<RenderReports> {
    const renders: RenderReports = {};
    if (!render) return renders;
    const pages = items.filter((i) => i.trust !== "trusted" && i.content_type === "text/html");
    const reports = await Promise.all(
      pages.map((i) => render(i).catch((err: unknown): RenderReport => ({ ok: false, error: `render failed: ${String(err)}` }))),
    );
    pages.forEach((item, k) => (renders[hashCanonical(item)] = reports[k]!));
    return renders;
  }

  function loadMerchants(tenantId: string): MerchantRecord[] {
    const rows = db.prepare("SELECT merchant_id, name, payee_emails, checkout_origins FROM merchants WHERE tenant_id = ?").all(tenantId) as {
      merchant_id: string;
      name: string;
      payee_emails: string;
      checkout_origins: string;
    }[];
    return rows.map((r) => ({
      id: r.merchant_id,
      name: r.name,
      payee_emails: JSON.parse(r.payee_emails) as string[],
      checkout_origins: JSON.parse(r.checkout_origins) as string[],
    }));
  }

  // What the session has committed, plus what live tokens could still commit. An earlier token
  // for this same action does not count: issuing a new one retires it.
  function spentCents(sessionId: string, actionHash: string, now: string): number {
    const row = db
      .prepare(
        "SELECT COALESCE(SUM(amount_cents), 0) AS spent FROM action_tokens " +
          "WHERE session_id = ? AND (committed_at IS NOT NULL OR (expires_at > ? AND action_hash <> ?))",
      )
      .get(sessionId, now, actionHash) as { spent: number };
    return row.spent;
  }

  // Session risk accumulates across calls, so a slow multi-turn attack still crosses the threshold.
  function addRisk(sessionId: string, result: EngineResult) {
    const penalty = result.decision === "ALLOW" ? 0 : bundle.risk.penalty[result.decision];
    db.prepare("UPDATE sessions SET risk_score = risk_score + ? WHERE id = ?").run(penalty, sessionId);
  }

  function record(
    tenantId: string,
    checkpoint: Checkpoint,
    sessionId: string | null,
    result: EngineResult,
    actionHash: string | null = null,
  ): DecisionRecord {
    const rec: DecisionRecord = {
      id: randomUUID(),
      tenant_id: tenantId,
      session_id: sessionId,
      checkpoint,
      decision: result.decision,
      reasons: result.reasons,
      policy_version: POLICY_VERSION,
      rule_bundle_version: bundle.version,
      model_hashes: Object.fromEntries((result.sensor_scores ?? []).map((s) => [s.sensor_id, s.model_sha256])),
      action_hash: actionHash,
      graph_path: result.path ?? [],
      ...(result.shadow && { shadow_reasons: result.shadow }),
      ...(result.sensor_scores && { sensor_scores: result.sensor_scores }),
      created_at: new Date().toISOString(),
    };
    ledger.append("decision", rec);
    db.prepare("INSERT INTO decisions (id, tenant_id, session_id, checkpoint, decision, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
      rec.id,
      tenantId,
      sessionId,
      checkpoint,
      rec.decision,
      rec.created_at,
    );
    return rec;
  }

  const respond = (rec: DecisionRecord) => ({
    decision_id: rec.id,
    decision: rec.decision,
    reasons: rec.reasons,
    ...(rec.graph_path.length > 0 && { graph_path: rec.graph_path }),
    rule_bundle_version: rec.rule_bundle_version,
  });

  // Checkpoint 1 — intent intake. Returns a canary for the business to plant in the agent's prompt.
  v1.post("/sessions", async (req, reply) => {
    const tenantId = tenantOf(req);
    const body = CreateSessionBody.parse(req.body);
    const id = randomUUID();
    const mandateHash = hashCanonical(body.mandate);
    const canary = `mwf-canary-${randomBytes(8).toString("hex")}`;
    const result = checkIntent({ prompt: body.prompt, mandate: body.mandate, now: new Date() }, bundle);
    db.prepare(
      "INSERT INTO sessions (id, tenant_id, prompt, mandate, mandate_hash, created_at, expires_at, canary, risk_score) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(id, tenantId, body.prompt, JSON.stringify(body.mandate), mandateHash, new Date().toISOString(), body.mandate.expires_at, canary, result.risk);
    saveGraph(db, id, intentGraph(body.prompt, body.mandate));
    const rec = record(tenantId, "intent", id, result);
    return reply.code(201).send({ session_id: id, mandate_hash: mandateHash, canary, ...respond(rec) });
  });

  // Checkpoint 2 — context scan. Hard findings quarantine the item.
  v1.post("/context/inspect", async (req) => {
    const tenantId = tenantOf(req);
    const body = InspectContextBody.parse(req.body);
    loadSession(tenantId, body.session_id);
    const renders = await renderItems(body.items);
    const result = checkContext(body.items, bundle, renders);
    const quarantined = new Set(result.quarantined);
    const insert = db.prepare(
      "INSERT OR IGNORE INTO context_log (session_id, item_id, trust, content_hash, item, quarantined, created_at, render) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const now = new Date().toISOString();
    for (const item of body.items) {
      const hash = hashCanonical(item);
      const report = renders[hash];
      insert.run(body.session_id, item.id, item.trust, hash, JSON.stringify(item), quarantined.has(item.id) ? 1 : 0, now, report ? JSON.stringify(report) : null);
    }
    if (result.graph) saveGraph(db, body.session_id, result.graph);
    const rec = record(tenantId, "context", body.session_id, result);
    return { ...respond(rec), items: body.items.map((i) => ({ id: i.id, quarantined: quarantined.has(i.id) })) };
  });

  // Checkpoint 3 — action check. The only place ALLOW is decided. ALLOW gets an action token;
  // REVIEW gets a review token, which can be committed only after a person approves it; BLOCK
  // gets nothing.
  v1.post("/actions/check", async (req) => {
    const tenantId = tenantOf(req);
    const body = CheckActionBody.parse(req.body);
    loadSession(tenantId, body.session_id);
    const actionHash = hashCanonical(body.action);
    // Embedding sensors: vectors for the claims about the bought items, computed before the
    // (synchronous) decision. Without an embedder an enforced sensor holds those claims.
    const texts = sensorTexts({ context: loadContext(body.session_id).items, action: body.action }, bundle);
    const sensors = texts.length && embed ? await embed(texts) : undefined;
    // Session state is read after the await, so the decision and the risk update below run with
    // no await between them: a concurrent check cannot decide on a stale risk score. Context
    // added meanwhile has no vectors and is held by an enforced sensor.
    const session = loadSession(tenantId, body.session_id);
    const context = loadContext(body.session_id);
    const result = checkAction(
      {
        mandate: session.mandate,
        context: context.items,
        quarantined: context.quarantined,
        renders: context.renders,
        action: body.action,
        now: new Date(),
        merchants: loadMerchants(tenantId),
        canaries: session.canaries,
        spentCents: spentCents(body.session_id, actionHash, new Date().toISOString()),
        priorRisk: session.risk,
        ...(sensors && { sensors }),
      },
      bundle,
    );
    addRisk(body.session_id, result);
    if (result.graph) saveGraph(db, body.session_id, result.graph);
    const rec = record(tenantId, "action", body.session_id, result, actionHash);
    if (result.decision === "BLOCK") return { ...respond(rec), action_hash: actionHash, action_token: null };
    const review = result.decision === "REVIEW";

    const token = secret(review ? "mwf_rt_" : "mwf_at_");
    const idempotencyKey = randomUUID();
    const expiresAt = new Date(Date.now() + bundle.action_token_ttl_seconds * 1000).toISOString();
    const payment = PaymentArgs.safeParse(body.action.args);
    // One live token per action: two for the same action could both be committed.
    db.prepare("UPDATE action_tokens SET expires_at = ? WHERE session_id = ? AND action_hash = ? AND committed_at IS NULL").run(
      rec.created_at,
      body.session_id,
      actionHash,
    );
    db.prepare(
      "INSERT INTO action_tokens (token_hash, session_id, action_hash, created_at, expires_at, idempotency_key, amount_cents, review_status, review_decision_id, review_reasons) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      hashCanonical(token),
      body.session_id,
      actionHash,
      rec.created_at,
      expiresAt,
      idempotencyKey,
      payment.success ? toCents(payment.data.total) : 0,
      review ? "pending" : null,
      review ? rec.id : null,
      review ? JSON.stringify([...new Set(rec.reasons.map((r) => r.rule_id))]) : null,
    );
    // A held action: its money stays reserved while a person decides; nothing can commit it yet.
    if (review) return { ...respond(rec), action_hash: actionHash, action_token: null, review_token: token, expires_at: expiresAt };
    // Use idempotency_key as PayPal-Request-Id so a retried capture cannot charge twice.
    return { ...respond(rec), action_hash: actionHash, action_token: token, idempotency_key: idempotencyKey, expires_at: expiresAt };
  });

  // Checkpoint 4 — commit integrity. Tokens are single use: any attempt consumes them.
  v1.post("/actions/commit", async (req) => {
    const tenantId = tenantOf(req);
    const body = CommitActionBody.parse(req.body);
    loadSession(tenantId, body.session_id);
    const tokenHash = hashCanonical(body.action_token);
    const now = new Date();
    const token = db
      .prepare("SELECT action_hash, committed_at, expires_at, review_status FROM action_tokens WHERE token_hash = ? AND session_id = ?")
      .get(tokenHash, body.session_id) as { action_hash: string; committed_at: string | null; expires_at: string; review_status: string | null } | undefined;
    const prepared = body.prepared;
    // Something the system prepared that is already bound to another approved action cannot
    // settle this one.
    const preparedTaken =
      prepared !== undefined &&
      db
        .prepare("SELECT 1 FROM action_tokens WHERE prepared_tenant_id = ? AND prepared_system = ? AND prepared_reference = ? AND token_hash <> ?")
        .get(tenantId, prepared.system, prepared.reference, tokenHash) !== undefined;

    let result: EngineResult;
    if (!token) {
      result = { decision: "BLOCK", reasons: [{ rule_id: "COMMIT.UNKNOWN_TOKEN", message: "No such action token in this session" }], findings: [], risk: 0 };
    } else {
      const consumed = db
        .prepare("UPDATE action_tokens SET committed_at = ? WHERE token_hash = ? AND committed_at IS NULL")
        .run(now.toISOString(), tokenHash).changes;
      result = checkCommit({
        approvedActionHash: token.action_hash,
        executedAction: body.action,
        alreadyCommitted: consumed === 0,
        expired: Date.parse(token.expires_at) <= now.getTime(),
        ...(prepared && { prepared, merchants: loadMerchants(tenantId) }),
      });
      // A held action commits only once a person approved it.
      if (token.review_status === "pending" || token.review_status === "rejected") {
        const held = {
          rule_id: "COMMIT.REVIEW_NOT_APPROVED",
          message: `This action was held for review and is ${token.review_status === "pending" ? "not approved yet" : "rejected"}`,
        };
        result = { ...result, decision: "BLOCK", reasons: [held, ...(result.decision === "ALLOW" ? [] : result.reasons)] };
      }
      if (preparedTaken) {
        const reused = { rule_id: "COMMIT.EFFECT_REUSED", message: "This prepared action was already committed for another action" };
        result = { ...result, decision: "BLOCK", reasons: [reused, ...(result.decision === "ALLOW" ? [] : result.reasons)] };
      }
    }
    addRisk(body.session_id, result);
    const rec = record(tenantId, "commit", body.session_id, result, hashCanonical(body.action));
    // The first commit of a token binds what was prepared for it, so how it ends is recorded
    // against this decision. A replayed token never rebinds.
    if (token && prepared && !preparedTaken) {
      db.prepare(
        "UPDATE action_tokens SET prepared_tenant_id = ?, prepared_system = ?, prepared_reference = ?, commit_decision = ? WHERE token_hash = ? AND commit_decision IS NULL",
      ).run(tenantId, prepared.system, prepared.reference, rec.decision, tokenHash);
    }
    if (prepared) {
      ledger.append("effect", {
        tenant_id: tenantId,
        session_id: body.session_id,
        decision_id: rec.id,
        action_type: body.action.type,
        stage: "prepared",
        system: prepared.system,
        reference: prepared.reference,
        ready: prepared.ready,
        ...(prepared.status && { status: prepared.status }),
        effect: prepared.effect,
        ...(prepared.external_ids && { external_ids: prepared.external_ids }),
        commit_decision: rec.decision,
        recorded_at: new Date().toISOString(),
      });
    }
    // What the integration does next with what it prepared: execute only on ALLOW.
    const next = prepared ? (rec.decision === "ALLOW" ? "execute" : rec.decision === "BLOCK" ? "cancel" : "hold") : undefined;
    return { ...respond(rec), action_hash: rec.action_hash, ...(next && { next }) };
  });

  // The user declined, or the agent replaced the action: the token dies and its money is free again.
  v1.post("/actions/release", async (req) => {
    const tenantId = tenantOf(req);
    const body = ReleaseActionBody.parse(req.body);
    loadSession(tenantId, body.session_id);
    const released = db
      .prepare("UPDATE action_tokens SET expires_at = ? WHERE token_hash = ? AND session_id = ? AND committed_at IS NULL")
      .run(new Date().toISOString(), hashCanonical(body.action_token), body.session_id).changes;
    return { released: released > 0 };
  });

  // A person's answer to a REVIEW. The integration asks in its own UI (the model never answers),
  // and the answer is written to the ledger with the held decision's reasons. Approving refreshes
  // the token's expiry so the commit can follow; it does not skip the commit check, which still
  // compares what is executed with what was held. A BLOCK has no review token, so it cannot be
  // approved.
  v1.post("/actions/review", async (req, reply) => {
    const tenantId = tenantOf(req);
    const body = ReviewActionBody.parse(req.body);
    loadSession(tenantId, body.session_id);
    const tokenHash = hashCanonical(body.review_token);
    const row = db
      .prepare("SELECT action_hash, committed_at, expires_at, review_status, review_decision_id, review_reasons FROM action_tokens WHERE token_hash = ? AND session_id = ?")
      .get(tokenHash, body.session_id) as
      | { action_hash: string; committed_at: string | null; expires_at: string; review_status: string | null; review_decision_id: string | null; review_reasons: string | null }
      | undefined;
    if (!row || row.review_status === null) throw new NotFound();
    if (row.review_status !== "pending" || row.committed_at !== null) {
      return reply.code(409).send({ error: "already_reviewed", review_status: row.review_status });
    }
    const now = new Date();
    if (Date.parse(row.expires_at) <= now.getTime()) return reply.code(409).send({ error: "expired" });
    const approved = body.verdict === "approve";
    const expiresAt = approved ? new Date(now.getTime() + bundle.action_token_ttl_seconds * 1000).toISOString() : now.toISOString();
    const changed = db
      .prepare("UPDATE action_tokens SET review_status = ?, expires_at = ? WHERE token_hash = ? AND review_status = 'pending'")
      .run(approved ? "approved" : "rejected", expiresAt, tokenHash).changes;
    if (changed === 0) return reply.code(409).send({ error: "already_reviewed" });
    const entry = ledger.append("review", {
      tenant_id: tenantId,
      session_id: body.session_id,
      decision_id: row.review_decision_id,
      action_hash: row.action_hash,
      verdict: body.verdict,
      reviewer: body.reviewer,
      ...(body.note && { note: body.note }),
      held_for: row.review_reasons ? (JSON.parse(row.review_reasons) as string[]) : [],
      recorded_at: now.toISOString(),
    });
    return { review_status: approved ? "approved" : "rejected", ledger_seq: entry.seq, ...(approved && { expires_at: expiresAt }) };
  });

  // How a prepared action ended. The firewall never executes anything itself: this records what
  // the integration did, with the outside system's ids, and whether it followed the decision.
  v1.post("/actions/outcome", async (req, reply) => {
    const tenantId = tenantOf(req);
    const body = OutcomeBody.parse(req.body);
    loadSession(tenantId, body.session_id);
    const row = db
      .prepare(
        "SELECT token_hash, commit_decision, outcome FROM action_tokens WHERE prepared_tenant_id = ? AND session_id = ? AND prepared_system = ? AND prepared_reference = ?",
      )
      .get(tenantId, body.session_id, body.system, body.reference) as { token_hash: string; commit_decision: string; outcome: string | null } | undefined;
    if (!row) throw new NotFound();
    // "held" can later become executed or cancelled; those two are final.
    if (row.outcome === "executed" || row.outcome === "cancelled") return reply.code(409).send({ error: "already_recorded", outcome: row.outcome });
    // Cancelling is always safe. Executing anything the firewall did not ALLOW is recorded as such.
    const followsDecision =
      body.outcome === "cancelled" || (body.outcome === "executed" ? row.commit_decision === "ALLOW" : row.commit_decision === "REVIEW");
    db.prepare("UPDATE action_tokens SET outcome = ? WHERE token_hash = ?").run(body.outcome, row.token_hash);
    const entry = ledger.append("effect", {
      tenant_id: tenantId,
      session_id: body.session_id,
      stage: body.outcome,
      system: body.system,
      reference: body.reference,
      status: body.status,
      ...(body.external_ids && { external_ids: body.external_ids }),
      commit_decision: row.commit_decision,
      follows_decision: followsDecision,
      recorded_at: new Date().toISOString(),
    });
    return { recorded: true, ledger_seq: entry.seq, follows_decision: followsDecision };
  });

  // Checkpoint 5 — output check.
  v1.post("/outputs/check", async (req) => {
    const tenantId = tenantOf(req);
    const body = CheckOutputBody.parse(req.body);
    const session = loadSession(tenantId, body.session_id);
    const result = checkOutput({ content: body.output.content, canaries: session.canaries }, bundle);
    addRisk(body.session_id, result);
    return respond(record(tenantId, "output", body.session_id, result));
  });

  // Feedback — how real-world attacks reach the learning loop.
  v1.post("/feedback", async (req, reply) => {
    const tenantId = tenantOf(req);
    const body = FeedbackBody.parse(req.body);
    if (body.session_id) loadSession(tenantId, body.session_id);
    if (body.decision_id) {
      const owner = db.prepare("SELECT session_id FROM decisions WHERE id = ? AND tenant_id = ?").get(body.decision_id, tenantId) as
        | { session_id: string | null }
        | undefined;
      if (!owner || (body.session_id && owner.session_id !== body.session_id)) throw new NotFound();
    }
    const id = randomUUID();
    ledger.append("feedback", { id, tenant_id: tenantId, ...body, received_at: new Date().toISOString() });
    return reply.code(202).send({ feedback_id: id, received: true });
  });
}

