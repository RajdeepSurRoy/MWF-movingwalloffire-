import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Mandate, ProposedAction } from "@mwf/core";
import { buildApp, createApiKey, openDatabase, upsertMerchant } from "@mwf/firewall-api";
import { FirewallClient, Guard, type PaymentPlugin, type PaymentReceipt, type ProposalResult } from "@mwf/sdk";

// M6 evidence: two payments through the whole two-phase commit, with PayPal (or the fake).
//   ALLOW: Shop A's checkout, paid to Shop A's registered payee -> authorize, commit, capture.
//   BLOCK: Shop B's checkout looks right (its registered address), but the order names no payee,
//          so PayPal would pay someone the registry does not list for Shop B -> authorize, void.
// The second is the case the action check cannot see: only the provider knows who gets paid.

const SHOP_A = "https://shop-a.example";
const SHOP_B = "https://shop-b.example";

// A payment entry of the ledger: the provider ids, the stage, and the commit decision.
export type LedgerPayment = { seq: number; hash: string; [field: string]: unknown };

export interface EvidenceRun {
  label: string;
  result: ProposalResult<PaymentReceipt>;
}

export interface EvidenceOptions {
  payments: PaymentPlugin;
  // The account PayPal actually pays: in the sandbox, the app's business account email.
  payee: string;
}

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

// A firewall in this process with a throwaway key and an in-memory ledger, so the evidence can
// be read back. Shop A pays the sandbox payee; Shop B's real payee is someone else.
export async function startPaymentFirewall(payee: string): Promise<{ client: FirewallClient; db: DatabaseSync; close: () => Promise<void> }> {
  const db = openDatabase(":memory:");
  const { key } = createApiKey(db, "demo", "payments");
  upsertMerchant(db, "demo", { id: "shop-a", name: "Shop A", payee_emails: [payee], checkout_origins: [SHOP_A] });
  upsertMerchant(db, "demo", { id: "shop-b", name: "Shop B", payee_emails: ["payments@shop-b.example"], checkout_origins: [SHOP_B] });
  const app = buildApp({ db });
  const baseUrl = await app.listen({ port: 0, host: "127.0.0.1" });
  return { client: new FirewallClient({ baseUrl, apiKey: key }), db, close: () => app.close() };
}

export async function runPaymentEvidence({ payments, payee }: EvidenceOptions) {
  const firewall = await startPaymentFirewall(payee);
  try {
    const executed: { action: ProposedAction; receipt: PaymentReceipt }[] = [];
    const guard = await Guard.start<PaymentReceipt>({
      firewall: firewall.client,
      prompt: "Buy AA batteries, $20 at most.",
      mandate: mandate(),
      openTab: () => Promise.reject(new Error("no browsing in this run")),
      payments,
      // The shop's own order step: runs only after the money was captured.
      execute: async (action, _key, payment) => {
        if (!payment) throw new Error("a payment reached execute without a capture");
        executed.push({ action, receipt: payment });
        return payment;
      },
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
      .filter((r) => r.kind === "payment")
      .map((r): LedgerPayment => ({ ...(JSON.parse(r.payload) as Record<string, unknown>), seq: r.seq, hash: r.hash }));
    return { runs, executed, ledger, sessionId: guard.sessionId, runId: randomUUID() };
  } finally {
    await firewall.close();
  }
}
