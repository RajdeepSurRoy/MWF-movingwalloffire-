import { Ledger } from "@mwf/core";
import { beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { createApiKey } from "./auth.js";
import { openDatabase } from "./store.js";

const mandate = {
  intent_text: "AA batteries under $20",
  category: "batteries",
  max_total: { value: "20.00", currency: "USD" },
  merchants: ["shop-a"],
  allowed_actions: ["payment.authorize", "payment.capture"],
  expires_at: "2099-01-01T00:00:00Z",
};

const action = {
  type: "payment.authorize",
  args: {
    merchant: { id: "shop-a", name: "Shop A" },
    items: [{ sku: "aa-8", name: "AA batteries, 8 pack", category: "batteries", unit_price: { value: "7.99", currency: "USD" }, quantity: 1 }],
    total: { value: "7.99", currency: "USD" },
  },
};

describe("firewall API", () => {
  let db: ReturnType<typeof openDatabase>;
  let app: ReturnType<typeof buildApp>;
  let auth: { authorization: string };

  beforeEach(() => {
    db = openDatabase(":memory:");
    app = buildApp({ db });
    auth = { authorization: `Bearer ${createApiKey(db, "tenant-a", "test").key}` };
  });

  async function newSession(headers = auth) {
    const res = await app.inject({ method: "POST", url: "/v1/sessions", headers, payload: { prompt: mandate.intent_text, mandate } });
    return { res, id: res.json().session_id as string };
  }

  it("reports health without a key and fails closed to REVIEW", async () => {
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, failClosedDecision: "REVIEW" });
  });

  it("rejects /v1 calls with no key or a wrong key", async () => {
    for (const headers of [{}, { authorization: "Bearer mwf_sk_test_nope" }, { authorization: "Basic abc" }]) {
      const res = await app.inject({ method: "POST", url: "/v1/sessions", headers, payload: {} });
      expect(res.statusCode).toBe(401);
    }
  });

  it("rejects a revoked key", async () => {
    db.exec("UPDATE api_keys SET revoked_at = '2026-01-01T00:00:00Z'");
    const { res } = await newSession();
    expect(res.statusCode).toBe(401);
  });

  it("stores only the hash of an API key", () => {
    const row = db.prepare("SELECT key_hash FROM api_keys").get() as { key_hash: string };
    expect(auth.authorization).not.toContain(row.key_hash);
    expect(row.key_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("validates input server-side", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: auth,
      payload: { prompt: "x", mandate: { ...mandate, max_total: { value: "20.5.0", currency: "usd" } } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_request");
  });

  it("returns REVIEW at every checkpoint while no rules exist", async () => {
    const { res, id } = await newSession();
    expect(res.statusCode).toBe(201);
    expect(res.json().decision).toBe("REVIEW");

    const calls = [
      { url: "/v1/context/inspect", payload: { session_id: id, items: [{ id: "p1", source: { kind: "web_page" }, content_type: "text/plain", content: "AA batteries $7.99" }] } },
      { url: "/v1/actions/check", payload: { session_id: id, action } },
      { url: "/v1/actions/commit", payload: { session_id: id, action_token: "none", action } },
      { url: "/v1/outputs/check", payload: { session_id: id, output: { content: "Ordered AA batteries." } } },
    ];
    for (const call of calls) {
      const r = await app.inject({ method: "POST", headers: auth, ...call });
      expect(r.statusCode, call.url).toBe(200);
      expect(r.json().decision, call.url).toBe("REVIEW");
    }
  });

  it("binds the action check to a hash of the exact action and issues no token without ALLOW", async () => {
    const { id } = await newSession();
    const r = await app.inject({ method: "POST", url: "/v1/actions/check", headers: auth, payload: { session_id: id, action } });
    expect(r.json().action_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.json().action_token).toBeNull();
  });

  it("does not let one tenant use another tenant's session", async () => {
    const { id } = await newSession();
    const other = { authorization: `Bearer ${createApiKey(db, "tenant-b", "test").key}` };
    const r = await app.inject({ method: "POST", url: "/v1/actions/check", headers: other, payload: { session_id: id, action } });
    expect(r.statusCode).toBe(404);
  });

  it("writes every decision and feedback to a verifiable ledger", async () => {
    const { id } = await newSession();
    await app.inject({ method: "POST", url: "/v1/actions/check", headers: auth, payload: { session_id: id, action } });
    const fb = await app.inject({ method: "POST", url: "/v1/feedback", headers: auth, payload: { session_id: id, kind: "user_report", note: "I didn't ask for this" } });
    expect(fb.statusCode).toBe(202);
    expect(new Ledger(db).verify()).toEqual({ ok: true, entries: 3 });
  });
});
