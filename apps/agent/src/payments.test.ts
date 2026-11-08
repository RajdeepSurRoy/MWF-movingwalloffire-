import { FakePayPal, PayPalPayments } from "@mwf/sdk";
import { describe, expect, it } from "vitest";
import { runPaymentEvidence } from "./payments.js";

// The M6 runs end to end: Guard, the real firewall API, and a PayPal stand-in that follows the
// sandbox's request and response shapes. The same runs go to the sandbox with `npm run pay-demo`.

const PAYEE = "sb-merchant@business.example.com";
const plugin = (paypal: FakePayPal) =>
  new PayPalPayments({ clientId: "client", clientSecret: "secret", apiBase: "https://api-m.sandbox.paypal.com", vaultId: "VAULT1", fetch: paypal.fetch });

describe("two-phase PayPal payments", () => {
  it("captures the ALLOW, voids the BLOCK, and writes both to the ledger", async () => {
    const paypal = new FakePayPal({ defaultPayee: PAYEE });
    const { runs, executed, ledger } = await runPaymentEvidence({ payments: plugin(paypal), payee: PAYEE });

    expect(runs[0]!.result).toMatchObject({ status: "executed", receipt: { capture_id: "FAKECAPTURE1", status: "COMPLETED" } });
    expect(runs[1]!.result).toMatchObject({ status: "BLOCK", rule_ids: ["COMMIT.HOLD_PAYEE_MISMATCH"], hold: { authorization_id: "FAKEAUTH2" } });
    // Only the captured payment reached the shop's order step.
    expect(executed.map((e) => e.receipt.hold.order_id)).toEqual(["FAKEORDER1"]);
    expect(paypal.authorizations.get("FAKEAUTH1")!.status).toBe("CAPTURED");
    expect(paypal.authorizations.get("FAKEAUTH2")!.status).toBe("VOIDED");

    expect(ledger.map((e) => [e.stage, e.order_id, e.authorization_id, e.commit_decision])).toEqual([
      ["authorized", "FAKEORDER1", "FAKEAUTH1", "ALLOW"],
      ["captured", "FAKEORDER1", "FAKEAUTH1", "ALLOW"],
      ["authorized", "FAKEORDER2", "FAKEAUTH2", "BLOCK"],
      ["voided", "FAKEORDER2", "FAKEAUTH2", "BLOCK"],
    ]);
    expect(ledger[1]).toMatchObject({ capture_id: "FAKECAPTURE1", follows_decision: true });
    expect(ledger[3]).toMatchObject({ status: "VOIDED", follows_decision: true });
  });

  it("voids when PayPal holds a different amount than was approved", async () => {
    const paypal = new FakePayPal({ defaultPayee: PAYEE, tamper: (o) => (o.amount.value = "125.00") });
    const { runs, executed } = await runPaymentEvidence({ payments: plugin(paypal), payee: PAYEE });
    expect(runs[0]!.result).toMatchObject({ status: "BLOCK", rule_ids: ["COMMIT.HOLD_AMOUNT_MISMATCH"] });
    expect(executed).toEqual([]);
    expect(paypal.captures.size).toBe(0);
    expect([...paypal.authorizations.values()].map((a) => a.status)).toEqual(["VOIDED", "VOIDED"]);
  });
});
