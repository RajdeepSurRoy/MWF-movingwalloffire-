import { describe, expect, it } from "vitest";
import { runPaymentEvidence } from "./payments.js";
import { FakePayPal } from "./paypal/fake-paypal.js";
import { PayPalSandbox } from "./paypal/paypal.js";

// The M6 runs end to end: the demo business's PayPal code, the SDK's two-phase commit, the real
// firewall API, and a PayPal stand-in following the sandbox's shapes. `npm run pay-demo` runs the
// same against the sandbox.

const PAYEE = "sb-merchant@business.example.com";
const sandbox = (paypal: FakePayPal) =>
  new PayPalSandbox({ clientId: "client", clientSecret: "secret", apiBase: "https://api-m.sandbox.paypal.com", vaultId: "VAULT1", fetch: paypal.fetch });

describe("two-phase PayPal payments", () => {
  it("captures the ALLOW, voids the BLOCK, and writes both to the ledger", async () => {
    const paypal = new FakePayPal({ defaultPayee: PAYEE });
    const { runs, ledger } = await runPaymentEvidence({ paypal: sandbox(paypal), payee: PAYEE });

    expect(runs[0]!.result).toMatchObject({ status: "executed", receipt: { order_id: "FAKEORDER1", capture_id: "FAKECAPTURE1", status: "COMPLETED" } });
    expect(runs[1]!.result).toMatchObject({ status: "BLOCK", rule_ids: ["COMMIT.EFFECT_PAYEE_MISMATCH"], prepared: { reference: "FAKEAUTH2" } });
    expect(paypal.authorizations.get("FAKEAUTH1")!.status).toBe("CAPTURED");
    expect(paypal.authorizations.get("FAKEAUTH2")!.status).toBe("VOIDED");

    expect(ledger.map((e) => [e.stage, e.system, e.reference, e.commit_decision])).toEqual([
      ["prepared", "paypal", "FAKEAUTH1", "ALLOW"],
      ["executed", "paypal", "FAKEAUTH1", "ALLOW"],
      ["prepared", "paypal", "FAKEAUTH2", "BLOCK"],
      ["cancelled", "paypal", "FAKEAUTH2", "BLOCK"],
    ]);
    expect(ledger[0]).toMatchObject({ external_ids: { order_id: "FAKEORDER1" } });
    expect(ledger[1]).toMatchObject({ external_ids: { capture_id: "FAKECAPTURE1" }, follows_decision: true });
    expect(ledger[3]).toMatchObject({ status: "VOIDED", follows_decision: true });
  });

  it("voids when PayPal holds a different amount than was approved", async () => {
    const paypal = new FakePayPal({ defaultPayee: PAYEE, tamper: (o) => (o.amount.value = "125.00") });
    const { runs } = await runPaymentEvidence({ paypal: sandbox(paypal), payee: PAYEE });
    expect(runs[0]!.result).toMatchObject({ status: "BLOCK", rule_ids: ["COMMIT.EFFECT_AMOUNT_MISMATCH"] });
    expect(paypal.captures.size).toBe(0);
    expect([...paypal.authorizations.values()].map((a) => a.status)).toEqual(["VOIDED", "VOIDED"]);
  });
});
