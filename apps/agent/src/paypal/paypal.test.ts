import type { ProposedAction } from "@mwf/core";
import { describe, expect, it } from "vitest";
import { FakePayPal } from "./fake-paypal.js";
import { PayPalError, PayPalSandbox } from "./paypal.js";

const SANDBOX = "https://api-m.sandbox.paypal.com";
const action = (total = "12.50", payee_email?: string): ProposedAction => ({
  type: "payment.authorize",
  args: {
    merchant: { id: "shop-a", name: "Shop A", ...(payee_email && { payee_email }) },
    items: [{ sku: "AA-12", name: "AA batteries", category: "batteries", unit_price: { value: total, currency: "USD" }, quantity: 1 }],
    total: { value: total, currency: "USD" },
  },
  derived_from: [],
});
const plugin = (paypal: FakePayPal) =>
  new PayPalSandbox({ clientId: "client", clientSecret: "secret-never-shown", apiBase: SANDBOX, vaultId: "VAULT1", fetch: paypal.fetch });

// The demo business's PayPal code (not MWF's), against the stand-in.
describe("PayPalSandbox", () => {
  it("refuses anything but the sandbox", () => {
    for (const apiBase of ["https://api-m.paypal.com", "http://api-m.sandbox.paypal.com", "https://api-m.sandbox.paypal.com.evil.example"]) {
      expect(() => new PayPalSandbox({ clientId: "c", clientSecret: "s", apiBase, vaultId: "v" })).toThrow(PayPalError);
    }
  });

  it("reports the authorization as PayPal records it, as a prepared effect", async () => {
    const paypal = new FakePayPal({ defaultPayee: "pay@shop-a.example" });
    const hold = await plugin(paypal).authorize(action(), "key-1");
    expect(hold).toEqual({
      system: "paypal",
      reference: "FAKEAUTH1",
      ready: true,
      status: "CREATED",
      effect: { amount: { value: "12.50", currency: "USD" }, payee: { email: "pay@shop-a.example", id: "FAKEMERCHANT1" } },
      external_ids: { order_id: "FAKEORDER1" },
    });
    expect([...paypal.orders.values()][0]!.custom_id).toBe("key-1");
  });

  it("reports what PayPal holds even when it differs from the action", async () => {
    const paypal = new FakePayPal({
      tamper: (o) => {
        o.amount.value = "99.00";
        o.payee = "thief@evil.example";
      },
    });
    const hold = await plugin(paypal).authorize(action(), "key-1");
    expect(hold.effect).toEqual({ amount: { value: "99.00", currency: "USD" }, payee: { email: "thief@evil.example", id: "FAKEMERCHANT1" } });
  });

  it("captures and voids, each idempotent under its own request id", async () => {
    const paypal = new FakePayPal();
    const p = plugin(paypal);
    const a = await p.authorize(action(), "key-1");
    expect(await p.capture(a, "key-1")).toEqual({ capture_id: "FAKECAPTURE1", status: "COMPLETED" });
    // A retried capture with the same key returns the same capture, not a second charge.
    expect(await p.capture(a, "key-1")).toEqual({ capture_id: "FAKECAPTURE1", status: "COMPLETED" });
    expect(paypal.captures.size).toBe(1);

    const b = await p.authorize(action("500.00"), "key-2");
    expect(await p.void(b, "key-2")).toEqual({ status: "VOIDED" });
    const ids = paypal.calls.filter((c) => c.method === "POST" && c.path !== "/v1/oauth2/token").map((c) => c.requestId);
    expect(ids).toEqual(["key-1", "key-1-capture", "key-1-capture", "key-2", "key-2-void"]);
  });

  it("a retried authorize returns the same order", async () => {
    const paypal = new FakePayPal();
    const p = plugin(paypal);
    const first = await p.authorize(action(), "key-1");
    expect(await p.authorize(action(), "key-1")).toEqual(first);
    expect(paypal.orders.size).toBe(1);
  });

  it("errors carry PayPal's status and error name, never the secret or a body", async () => {
    const paypal = new FakePayPal();
    const p = plugin(paypal);
    const hold = await p.authorize(action(), "key-1");
    await p.void(hold, "key-1");
    const err = await p.capture(hold, "key-1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PayPalError);
    expect(err).toMatchObject({ status: 422, issue: "UNPROCESSABLE_ENTITY" });
    expect(JSON.stringify(err) + String(err)).not.toContain("secret-never-shown");
  });
});
