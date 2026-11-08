import type { DatabaseSync } from "node:sqlite";
import { Ledger } from "@mwf/core";
import { beforeEach, describe, expect, it } from "vitest";
import { type VerifyWebhook, buildApp } from "./app.js";
import { createApiKey } from "./auth.js";
import { openDatabase, upsertMerchant } from "./store.js";

// Two-phase payments: authorize at the provider, commit with the provider's hold, then record how
// the hold ended. The firewall checks what PayPal holds, not what the agent says.

const usd = (value: string) => ({ value, currency: "USD" });
const mandate = {
  intent_text: "AA batteries",
  category: "batteries",
  max_total: usd("40.00"),
  merchants: ["shop-a"],
  allowed_actions: ["payment.authorize"],
  expires_at: new Date(Date.now() + 86_400_000).toISOString(),
};
const action = {
  type: "payment.authorize",
  args: {
    merchant: { id: "shop-a", name: "Shop A", payee_email: "pay@shop-a.example" },
    items: [{ sku: "AA-12", name: "AA batteries", category: "batteries", unit_price: usd("12.50"), quantity: 1 }],
    total: usd("12.50"),
  },
  derived_from: [],
};
const hold = (over: Record<string, unknown> = {}) => ({
  provider: "paypal",
  order_id: "ORDER1",
  authorization_id: "AUTH1",
  status: "CREATED",
  amount: usd("12.50"),
  payee: { email: "pay@shop-a.example" },
  ...over,
});

const signed = { "paypal-auth-algo": "SHA256withRSA", "paypal-cert-url": "https://api.sandbox.paypal.com/cert", "paypal-transmission-id": "t1", "paypal-transmission-sig": "sig", "paypal-transmission-time": "2026-11-09T00:00:00Z" };
const event = (id: string, type = "PAYMENT.AUTHORIZATION.VOIDED", resource: object = { id: "AUTH1", status: "VOIDED" }) => ({ id, event_type: type, resource });

describe("payments", () => {
  let db: DatabaseSync;
  let app: ReturnType<typeof buildApp>;
  let auth: { authorization: string };
  let session: string;
  let verified: unknown[];
  const verify: VerifyWebhook = async (headers, e) => {
    verified.push(e);
    return headers["paypal-transmission-sig"] === "sig";
  };

  const post = async (url: string, payload: object, headers: Record<string, string> = auth) => app.inject({ method: "POST", url, headers, payload });
  const approve = async () => (await post("/v1/actions/check", { session_id: session, action })).json().action_token as string;
  const commit = async (token: string, h: object | null = hold()) =>
    (await post("/v1/actions/commit", { session_id: session, action_token: token, action, ...(h && { hold: h }) })).json();
  const settle = (body: object) => post("/v1/payments/settle", { session_id: session, provider: "paypal", authorization_id: "AUTH1", ...body });
  const payments = () => ledgerRows().filter((e) => e.kind === "payment").map((e) => JSON.parse(e.payload));
  const rules = (r: { reasons: { rule_id: string }[] }) => r.reasons.map((x) => x.rule_id);
  const ledgerRows = () => db.prepare("SELECT kind, payload FROM ledger ORDER BY seq").all() as { kind: string; payload: string }[];

  beforeEach(async () => {
    verified = [];
    db = openDatabase(":memory:");
    app = buildApp({ db, verifyPayPalWebhook: verify });
    auth = { authorization: `Bearer ${createApiKey(db, "tenant-a", "test").key}` };
    upsertMerchant(db, "tenant-a", { id: "shop-a", name: "Shop A", payee_emails: ["pay@shop-a.example"] });
    session = (await post("/v1/sessions", { prompt: mandate.intent_text, mandate })).json().session_id;
  });

  it("captures on ALLOW and writes the sandbox ids to the ledger", async () => {
    const c = await commit(await approve());
    expect(c).toMatchObject({ decision: "ALLOW", settle: "capture" });
    const s = await settle({ outcome: "captured", capture_id: "CAP1", status: "COMPLETED" });
    expect(s.json()).toMatchObject({ recorded: true, follows_decision: true });
    expect(payments()).toMatchObject([
      { stage: "authorized", order_id: "ORDER1", authorization_id: "AUTH1", commit_decision: "ALLOW" },
      { stage: "captured", order_id: "ORDER1", authorization_id: "AUTH1", capture_id: "CAP1", follows_decision: true },
    ]);
    expect(new Ledger(db).verify().ok).toBe(true);
  });

  it("voids when PayPal would pay someone else", async () => {
    const c = await commit(await approve(), hold({ payee: { email: "thief@evil.example" } }));
    expect(c).toMatchObject({ decision: "BLOCK", settle: "void" });
    expect(rules(c)).toEqual(["COMMIT.HOLD_PAYEE_MISMATCH"]);
    expect((await settle({ outcome: "voided", status: "VOIDED" })).json()).toMatchObject({ follows_decision: true });
  });

  it("voids when PayPal holds more than was approved", async () => {
    const c = await commit(await approve(), hold({ amount: usd("125.00") }));
    expect(rules(c)).toEqual(["COMMIT.HOLD_AMOUNT_MISMATCH"]);
  });

  it("records a capture the firewall did not allow as not following the decision", async () => {
    await commit(await approve(), hold({ amount: usd("125.00") }));
    expect((await settle({ outcome: "captured", capture_id: "CAP1", status: "COMPLETED" })).json()).toMatchObject({ follows_decision: false });
  });

  it("does not let one authorization settle two approved actions", async () => {
    await commit(await approve());
    const second = await commit(await approve());
    expect(second.decision).toBe("BLOCK");
    expect(rules(second)).toContain("COMMIT.HOLD_REUSED");
  });

  it("settles a hold once, and only one this session committed", async () => {
    await commit(await approve());
    expect((await settle({ outcome: "captured", capture_id: "CAP1", status: "COMPLETED" })).statusCode).toBe(200);
    expect((await settle({ outcome: "voided", status: "VOIDED" })).statusCode).toBe(409);
    expect((await settle({ authorization_id: "AUTH-UNKNOWN", outcome: "voided", status: "VOIDED" })).statusCode).toBe(404);
  });

  it("does not let another tenant settle this tenant's hold", async () => {
    await commit(await approve());
    const other = { authorization: `Bearer ${createApiKey(db, "tenant-b", "test").key}` };
    const r = await post("/v1/payments/settle", { session_id: session, provider: "paypal", authorization_id: "AUTH1", outcome: "voided", status: "VOIDED" }, other);
    expect(r.statusCode).toBe(404);
  });

  it("does not let another tenant block a payment by claiming its authorization id first", async () => {
    const other = { authorization: `Bearer ${createApiKey(db, "tenant-b", "test").key}` };
    upsertMerchant(db, "tenant-b", { id: "shop-a", name: "Shop A", payee_emails: ["pay@shop-a.example"] });
    const theirs = (await post("/v1/sessions", { prompt: mandate.intent_text, mandate }, other)).json().session_id;
    const token = (await post("/v1/actions/check", { session_id: theirs, action }, other)).json().action_token;
    await post("/v1/actions/commit", { session_id: theirs, action_token: token, action, hold: hold() }, other);
    expect((await commit(await approve())).decision).toBe("ALLOW");
  });

  it("a replayed token cannot rebind its hold", async () => {
    const token = await approve();
    await commit(token);
    expect((await commit(token, hold({ authorization_id: "AUTH2" }))).decision).toBe("BLOCK");
    expect((await settle({ authorization_id: "AUTH2", outcome: "captured", capture_id: "C", status: "COMPLETED" })).statusCode).toBe(404);
  });

  it("keeps commits without a hold working as before", async () => {
    const c = await commit(await approve(), null);
    expect(c.decision).toBe("ALLOW");
    expect(c.settle).toBeUndefined();
  });

  describe("webhooks", () => {
    const hook = async (body: object, headers: Record<string, string> = signed) => app.inject({ method: "POST", url: "/webhooks/paypal", headers, payload: body });

    it("records a verified event once, linked to the session whose hold it is", async () => {
      await commit(await approve());
      expect((await hook(event("WH-1"))).json()).toEqual({ received: true });
      expect((await hook(event("WH-1"))).json()).toEqual({ received: true, duplicate: true });
      const hooks = ledgerRows().filter((e) => e.kind === "webhook").map((e) => JSON.parse(e.payload));
      expect(hooks).toMatchObject([{ event_id: "WH-1", authorization_id: "AUTH1", tenant_id: "tenant-a", session_id: session }]);
    });

    it("links a capture event through its authorization", async () => {
      await commit(await approve());
      await hook(event("WH-2", "PAYMENT.CAPTURE.COMPLETED", { id: "CAP1", status: "COMPLETED", supplementary_data: { related_ids: { authorization_id: "AUTH1" } } }));
      const [h] = ledgerRows().filter((e) => e.kind === "webhook").map((e) => JSON.parse(e.payload));
      expect(h).toMatchObject({ resource_id: "CAP1", session_id: session });
    });

    it("rejects a delivery PayPal does not confirm, and records nothing", async () => {
      const r = await hook(event("WH-3"), { ...signed, "paypal-transmission-sig": "forged" });
      expect(r.statusCode).toBe(400);
      expect(ledgerRows().some((e) => e.kind === "webhook")).toBe(false);
    });

    it("is off when not configured", async () => {
      const off = buildApp({ db: openDatabase(":memory:") });
      expect((await off.inject({ method: "POST", url: "/webhooks/paypal", headers: signed, payload: event("WH-4") })).statusCode).toBe(503);
    });
  });
});
