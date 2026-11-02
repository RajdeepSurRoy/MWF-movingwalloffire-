import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import {
  ContextItem,
  DEFAULT_DECISION,
  type DecisionRecord,
  type DecisionResult,
  Ledger,
  Mandate,
  POLICY_VERSION,
  ProposedAction,
  RULE_BUNDLE_VERSION,
  checkAction,
  checkCommit,
  hashCanonical,
  type Checkpoint,
} from "@mwf/core";
import { authenticate } from "./auth.js";
import { openDatabase } from "./store.js";

declare module "fastify" {
  interface FastifyRequest {
    tenantId: string;
  }
}

const SessionId = z.string().uuid();

const CreateSessionBody = z.strictObject({ prompt: z.string().min(1).max(10_000), mandate: Mandate });
const InspectContextBody = z.strictObject({ session_id: SessionId, items: z.array(ContextItem).min(1).max(100) });
const CheckActionBody = z.strictObject({ session_id: SessionId, action: ProposedAction });
const CommitActionBody = z.strictObject({
  session_id: SessionId,
  action_token: z.string().min(1).max(200),
  action: ProposedAction,
});
const CheckOutputBody = z.strictObject({
  session_id: SessionId,
  output: z.strictObject({ content: z.string().max(500_000), destination: z.string().max(2000).optional() }),
});
const FeedbackBody = z.strictObject({
  session_id: SessionId.optional(),
  decision_id: z.string().uuid().optional(),
  kind: z.enum(["dispute", "chargeback", "reviewer_verdict", "user_report", "false_positive"]),
  verdict: z.enum(["ALLOW", "BLOCK"]).optional(),
  note: z.string().max(5000).optional(),
});

class NotFound extends Error {}

const STUB: DecisionResult = {
  decision: DEFAULT_DECISION,
  reasons: [{ rule_id: "ENGINE.NOT_IMPLEMENTED", message: "No rules yet (M2); failing closed to REVIEW" }],
};

export function buildApp({ db = openDatabase(":memory:") }: { db?: DatabaseSync } = {}) {
  const app = Fastify({ logger: false, bodyLimit: 1_048_576 });
  const ledger = new Ledger(db);

  app.decorateRequest("tenantId", "");

  // Every /v1 route needs a valid API key; /healthz does not.
  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/v1/")) return;
    const tenant = authenticate(db, req.headers.authorization);
    if (!tenant) return reply.code(401).send({ error: "unauthorized" });
    req.tenantId = tenant;
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof z.ZodError) return reply.code(400).send({ error: "invalid_request", issues: err.issues });
    if (err instanceof NotFound) return reply.code(404).send({ error: "not_found" });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) return reply.code(status).send({ error: "bad_request" });
    // Never leak internals. The client must treat this as "not allowed".
    return reply.code(500).send({ error: "internal", decision: DEFAULT_DECISION });
  });

  function loadSession(tenantId: string, sessionId: string) {
    const row = db
      .prepare("SELECT mandate FROM sessions WHERE id = ? AND tenant_id = ?")
      .get(sessionId, tenantId) as { mandate: string } | undefined;
    if (!row) throw new NotFound();
    return { mandate: Mandate.parse(JSON.parse(row.mandate)) };
  }

  function loadContext(sessionId: string): ContextItem[] {
    const rows = db.prepare("SELECT item FROM context_items WHERE session_id = ? ORDER BY created_at").all(sessionId) as {
      item: string;
    }[];
    return rows.map((r) => ContextItem.parse(JSON.parse(r.item)));
  }

  function record(
    req: FastifyRequest,
    checkpoint: Checkpoint,
    sessionId: string | null,
    result: DecisionResult,
    actionHash: string | null = null,
  ): DecisionRecord {
    const rec: DecisionRecord = {
      id: randomUUID(),
      tenant_id: req.tenantId,
      session_id: sessionId,
      checkpoint,
      decision: result.decision,
      reasons: result.reasons,
      policy_version: POLICY_VERSION,
      rule_bundle_version: RULE_BUNDLE_VERSION,
      model_hashes: {},
      action_hash: actionHash,
      graph_path: [],
      created_at: new Date().toISOString(),
    };
    ledger.append("decision", rec);
    return rec;
  }

  const respond = (rec: DecisionRecord) => ({ decision_id: rec.id, decision: rec.decision, reasons: rec.reasons });

  app.get("/healthz", async () => ({ ok: true, failClosedDecision: DEFAULT_DECISION }));

  // Checkpoint 1 — intent intake.
  app.post("/v1/sessions", async (req, reply: FastifyReply) => {
    const body = CreateSessionBody.parse(req.body);
    const id = randomUUID();
    const mandateHash = hashCanonical(body.mandate);
    db.prepare(
      "INSERT INTO sessions (id, tenant_id, prompt, mandate, mandate_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(id, req.tenantId, body.prompt, JSON.stringify(body.mandate), mandateHash, new Date().toISOString(), body.mandate.expires_at);
    const rec = record(req, "intent", id, STUB);
    return reply.code(201).send({ session_id: id, mandate_hash: mandateHash, ...respond(rec) });
  });

  // Checkpoint 2 — context scan.
  app.post("/v1/context/inspect", async (req) => {
    const body = InspectContextBody.parse(req.body);
    loadSession(req.tenantId, body.session_id);
    const insert = db.prepare(
      "INSERT OR REPLACE INTO context_items (session_id, item_id, trust, content_hash, item, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    );
    const now = new Date().toISOString();
    for (const item of body.items) {
      insert.run(body.session_id, item.id, item.trust, hashCanonical(item.content), JSON.stringify(item), now);
    }
    const rec = record(req, "context", body.session_id, STUB);
    return { ...respond(rec), items: body.items.map((i) => ({ id: i.id, quarantined: false })) };
  });

  // Checkpoint 3 — action check. The only place ALLOW can be decided.
  app.post("/v1/actions/check", async (req) => {
    const body = CheckActionBody.parse(req.body);
    const { mandate } = loadSession(req.tenantId, body.session_id);
    const actionHash = hashCanonical(body.action);
    const result = checkAction({ mandate, context: loadContext(body.session_id), action: body.action, now: new Date() });
    const rec = record(req, "action", body.session_id, result, actionHash);
    // Action tokens are issued on ALLOW only (M2). Until then there is nothing to commit.
    return { ...respond(rec), action_hash: actionHash, action_token: null };
  });

  // Checkpoint 4 — commit integrity.
  app.post("/v1/actions/commit", async (req) => {
    const body = CommitActionBody.parse(req.body);
    loadSession(req.tenantId, body.session_id);
    const actionHash = hashCanonical(body.action);
    const token = db
      .prepare("SELECT action_hash, committed_at FROM action_tokens WHERE token_hash = ? AND session_id = ?")
      .get(hashCanonical(body.action_token), body.session_id) as { action_hash: string; committed_at: string | null } | undefined;
    const result = token
      ? checkCommit({ approvedActionHash: token.action_hash, executedAction: body.action, alreadyCommitted: token.committed_at !== null })
      : STUB;
    const rec = record(req, "commit", body.session_id, result, actionHash);
    return { ...respond(rec), action_hash: actionHash };
  });

  // Checkpoint 5 — output check.
  app.post("/v1/outputs/check", async (req) => {
    const body = CheckOutputBody.parse(req.body);
    loadSession(req.tenantId, body.session_id);
    return respond(record(req, "output", body.session_id, STUB));
  });

  // Feedback — how real-world attacks reach the learning loop.
  app.post("/v1/feedback", async (req, reply) => {
    const body = FeedbackBody.parse(req.body);
    if (body.session_id) loadSession(req.tenantId, body.session_id);
    const id = randomUUID();
    ledger.append("feedback", { id, tenant_id: req.tenantId, ...body, received_at: new Date().toISOString() });
    return reply.code(202).send({ feedback_id: id, received: true });
  });

  return app;
}
