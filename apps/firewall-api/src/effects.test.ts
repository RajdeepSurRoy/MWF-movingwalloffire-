import type { DatabaseSync } from "node:sqlite";
import { Ledger } from "@mwf/core";
import { beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { createApiKey } from "./auth.js";
import { openDatabase, upsertMerchant } from "./store.js";

// Two-phase commit for irreversible actions. The integration has its outside system prepare the
// action, commits with what that system reports, then executes or cancels it with its own code and
// reports the outcome. The firewall checks and records; it never acts on the system.

const usd = (value: string) => ({ value, currency: "USD" });
const mandate = {
  intent_text: "AA batteries",
  category: "batteries",
  max_total: usd("40.00"),
  merchants: ["shop-a"],
  allowed_actions: ["payment.authorize"],
  expires_at: new Date(Date.now() + 86_400_000).toISOString(),
};
const payment = {
  type: "payment.authorize",
  args: {
    merchant: { id: "shop-a", name: "Shop A", payee_email: "pay@shop-a.example" },
    items: [{ sku: "AA-12", name: "AA batteries", category: "batteries", unit_price: usd("12.50"), quantity: 1 }],
    total: usd("12.50"),
  },
  derived_from: [],
};
// What a payment provider reports after authorizing (PayPal here, but nothing in the API is PayPal's).
const prepared = (effect: Record<string, unknown> = {}, over: Record<string, unknown> = {}) => ({
  system: "paypal",
  reference: "AUTH1",
  ready: true,
  status: "CREATED",
  effect: { amount: usd("12.50"), payee: { email: "pay@shop-a.example" }, ...effect },
  external_ids: { order_id: "ORDER1" },
  ...over,
});

describe("prepared actions", () => {
  let db: DatabaseSync;
  let app: ReturnType<typeof buildApp>;
  let auth: { authorization: string };
  let session: string;

  const post = async (url: string, payload: object, headers: Record<string, string> = auth) => app.inject({ method: "POST", url, headers, payload });
  const approve = async (action: object = payment) => (await post("/v1/actions/check", { session_id: session, action })).json().action_token as string;
  const commit = async (token: string, pr: object | null = prepared(), action: object = payment) =>
    (await post("/v1/actions/commit", { session_id: session, action_token: token, action, ...(pr && { prepared: pr }) })).json();
  const outcome = (body: object) => post("/v1/actions/outcome", { session_id: session, system: "paypal", reference: "AUTH1", ...body });
  const effects = () =>
    (db.prepare("SELECT kind, payload FROM ledger ORDER BY seq").all() as { kind: string; payload: string }[]).filter((r) => r.kind === "effect").map((r) => JSON.parse(r.payload));
  const rules = (r: { reasons: { rule_id: string }[] }) => r.reasons.map((x) => x.rule_id);

  beforeEach(async () => {
    db = openDatabase(":memory:");
    app = buildApp({ db });
    auth = { authorization: `Bearer ${createApiKey(db, "tenant-a", "test").key}` };
    upsertMerchant(db, "tenant-a", { id: "shop-a", name: "Shop A", payee_emails: ["pay@shop-a.example"] });
    session = (await post("/v1/sessions", { prompt: mandate.intent_text, mandate })).json().session_id;
  });

  it("says execute on ALLOW and records the system's ids for both steps", async () => {
    expect(await commit(await approve())).toMatchObject({ decision: "ALLOW", next: "execute" });
    const r = await outcome({ outcome: "executed", status: "COMPLETED", external_ids: { capture_id: "CAP1" } });
    expect(r.json()).toMatchObject({ recorded: true, follows_decision: true });
    expect(effects()).toMatchObject([
      { stage: "prepared", system: "paypal", reference: "AUTH1", external_ids: { order_id: "ORDER1" }, commit_decision: "ALLOW" },
      { stage: "executed", reference: "AUTH1", external_ids: { capture_id: "CAP1" }, follows_decision: true },
    ]);
    expect(new Ledger(db).verify().ok).toBe(true);
  });

  it("says cancel when the provider would pay someone else", async () => {
    const c = await commit(await approve(), prepared({ payee: { email: "thief@evil.example" } }));
    expect(c).toMatchObject({ decision: "BLOCK", next: "cancel" });
    expect(rules(c)).toEqual(["COMMIT.EFFECT_PAYEE_MISMATCH"]);
    expect((await outcome({ outcome: "cancelled", status: "VOIDED" })).json()).toMatchObject({ follows_decision: true });
  });

  it("says cancel when the provider holds more than was approved", async () => {
    expect(rules(await commit(await approve(), prepared({ amount: usd("125.00") })))).toEqual(["COMMIT.EFFECT_AMOUNT_MISMATCH"]);
  });

  it("records an execution the firewall did not allow as not following the decision", async () => {
    await commit(await approve(), prepared({ amount: usd("125.00") }));
    expect((await outcome({ outcome: "executed", status: "COMPLETED" })).json()).toMatchObject({ follows_decision: false });
  });

  it("does not let one prepared action settle two approved actions", async () => {
    await commit(await approve());
    const second = await commit(await approve());
    expect(second.decision).toBe("BLOCK");
    expect(rules(second)).toContain("COMMIT.EFFECT_REUSED");
  });

  it("does not let another tenant block an action by claiming its reference first", async () => {
    const other = { authorization: `Bearer ${createApiKey(db, "tenant-b", "test").key}` };
    upsertMerchant(db, "tenant-b", { id: "shop-a", name: "Shop A", payee_emails: ["pay@shop-a.example"] });
    const theirs = (await post("/v1/sessions", { prompt: mandate.intent_text, mandate }, other)).json().session_id;
    const token = (await post("/v1/actions/check", { session_id: theirs, action: payment }, other)).json().action_token;
    await post("/v1/actions/commit", { session_id: theirs, action_token: token, action: payment, prepared: prepared() }, other);
    expect((await commit(await approve())).decision).toBe("ALLOW");
  });

  it("records an outcome once, and only for something this session committed", async () => {
    await commit(await approve());
    expect((await outcome({ outcome: "executed", status: "COMPLETED" })).statusCode).toBe(200);
    expect((await outcome({ outcome: "cancelled", status: "VOIDED" })).statusCode).toBe(409);
    expect((await outcome({ reference: "AUTH-UNKNOWN", outcome: "cancelled", status: "VOIDED" })).statusCode).toBe(404);
  });

  it("does not let another tenant report this tenant's outcome", async () => {
    await commit(await approve());
    const other = { authorization: `Bearer ${createApiKey(db, "tenant-b", "test").key}` };
    const r = await post("/v1/actions/outcome", { session_id: session, system: "paypal", reference: "AUTH1", outcome: "cancelled", status: "VOIDED" }, other);
    expect(r.statusCode).toBe(404);
  });

  it("a replayed token cannot rebind what was prepared", async () => {
    const token = await approve();
    await commit(token);
    expect((await commit(token, prepared({}, { reference: "AUTH2" }))).decision).toBe("BLOCK");
    expect((await outcome({ reference: "AUTH2", outcome: "executed", status: "COMPLETED" })).statusCode).toBe(404);
  });

  it("keeps commits without a prepared effect working as before", async () => {
    const c = await commit(await approve(), null);
    expect(c.decision).toBe("ALLOW");
    expect(c.next).toBeUndefined();
  });

  it("has no provider webhook route: the firewall holds no provider credentials", async () => {
    expect((await app.inject({ method: "POST", url: "/webhooks/paypal", payload: {} })).statusCode).toBe(404);
  });
});
