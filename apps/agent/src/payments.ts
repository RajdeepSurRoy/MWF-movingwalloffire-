import type { DatabaseSync } from "node:sqlite";
import type { Mandate } from "@mwf/core";
import { buildApp, createApiKey, openDatabase, upsertMerchant } from "@mwf/firewall-api";
import { FirewallClient, Guard, type ProposalResult } from "@mwf/sdk";
import { type PayPalSandbox, type PaymentReceipt, paypalTwoPhase } from "./paypal/paypal.js";

// M6 evidence: two payments through the two-phase commit. The demo business pays with its own
// PayPal code; MWF only checks and records.
//   ALLOW: Shop A's checkout, paid to Shop A's registered payee -> authorized, checked, captured.
//   BLOCK: Shop B's checkout looks right (its registered address), but the order names no payee,
//          so PayPal would pay someone the registry does not list for Shop B -> authorized, voided.
// The second is the case the action check cannot see: only the provider knows who gets paid.

const SHOP_A = "https://shop-a.example";
const SHOP_B = "https://shop-b.example";

export interface EvidenceRun {
  label: string;
  result: ProposalResult<PaymentReceipt>;
}

// An entry of the ledger's evidence trail: the outside system's ids, the stage, the decision.
export type LedgerEffect = { seq: number; hash: string; [field: string]: unknown };

const mandate = (): Mandate => ({
  intent_text: "AA batteries, $20 at most",
  category: "batteries",
  max_total: { value: "20.00", currency: "USD" },
  merchants: ["shop-a", "shop-b"],
  allowed_actions: ["payment.authorize"],
  expires_at: new Date(Date.now() + 3_600_000).toISOString(),
});

const purchase = (merchant: Record<string, string>, value: string) => ({
  merchant,
  items: [{ sku: "AA-12", name: "AA batteries, 12 pack", category: "batteries", unit_price: { value, currency: "USD" }, quantity: 1 }],
  total: { value, currency: "USD" },
});

// A firewall in this process with a throwaway key and an in-memory ledger, so the evidence can be
// read back. Shop A is paid to the sandbox payee; Shop B's real payee is someone else.
export async function startPaymentFirewall(payee: string): Promise<{ client: FirewallClient; db: DatabaseSync; close: () => Promise<void> }> {
  const db = openDatabase(":memory:");
  const { key } = createApiKey(db, "demo", "payments");
  upsertMerchant(db, "demo", { id: "shop-a", name: "Shop A", payee_emails: [payee], checkout_origins: [SHOP_A] });
  upsertMerchant(db, "demo", { id: "shop-b", name: "Shop B", payee_emails: ["payments@shop-b.example"], checkout_origins: [SHOP_B] });
  const app = buildApp({ db });
  const baseUrl = await app.listen({ port: 0, host: "127.0.0.1" });
  return { client: new FirewallClient({ baseUrl, apiKey: key }), db, close: () => app.close() };
}

// `payee` is the account PayPal really pays: in the sandbox, the app's business account email.
export async function runPaymentEvidence({ paypal, payee }: { paypal: PayPalSandbox; payee: string }) {
  const firewall = await startPaymentFirewall(payee);
  try {
    const guard = await Guard.start<PaymentReceipt>({
      firewall: firewall.client,
      prompt: "Buy AA batteries, $20 at most.",
      mandate: mandate(),
      openTab: () => Promise.reject(new Error("no browsing in this run")),
      twoPhase: paypalTwoPhase(paypal),
      // Every action here is a payment, so it always goes through twoPhase.
      execute: () => Promise.reject(new Error("payments go through the two-phase commit")),
      allowedOrigins: [],
    });
    const runs: EvidenceRun[] = [
      {
        label: "ALLOW: Shop A, paid to its registered payee",
        result: await guard.tools.propose("payment.authorize", purchase({ id: "shop-a", name: "Shop A", payee_email: payee, checkout_origin: `${SHOP_A}/checkout` }, "12.50")),
      },
      {
        label: "BLOCK: Shop B's checkout, but PayPal would pay someone else",
        result: await guard.tools.propose("payment.authorize", purchase({ id: "shop-b", name: "Shop B", checkout_origin: `${SHOP_B}/checkout` }, "5.00")),
      },
    ];
    const ledger = (firewall.db.prepare("SELECT seq, kind, payload, hash FROM ledger ORDER BY seq").all() as { seq: number; kind: string; payload: string; hash: string }[])
      .filter((r) => r.kind === "effect")
      .map((r): LedgerEffect => ({ ...(JSON.parse(r.payload) as Record<string, unknown>), seq: r.seq, hash: r.hash }));
    return { runs, ledger, sessionId: guard.sessionId };
  } finally {
    await firewall.close();
  }
}
