// M6 evidence run: one payment captured on ALLOW, one voided on BLOCK, ids in the ledger.
// The PayPal calls are this demo business's own code (./paypal/); MWF only checks and records.
//
//   npm run pay-demo -w @mwf/agent -- --fake       # offline, against the PayPal stand-in
//   npm run pay-demo -w @mwf/agent                 # PayPal sandbox (reads the repo's .env)
//
// The sandbox run needs PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_API_BASE (sandbox),
// PAYPAL_PAYEE_EMAIL (the sandbox app's business account email) and a vaulted buyer wallet:
// run the Vault spike's `setup` and `token` steps first (spikes/paypal-vault/README.md).
// Prints sandbox ids and statuses only, never credentials.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runPaymentEvidence } from "./payments.js";
import { FakePayPal } from "./paypal/fake-paypal.js";
import { PayPalSandbox } from "./paypal/paypal.js";

const fake = process.argv.includes("--fake");
const root = resolve(import.meta.dirname, "../../..");
if (!fake && existsSync(resolve(root, ".env"))) process.loadEnvFile(resolve(root, ".env"));

function fail(message: string): never {
  console.error(`✖ ${message}`);
  process.exit(1);
}

let payee: string;
let paypal: PayPalSandbox;
if (fake) {
  payee = "sb-merchant@business.example.com";
  paypal = new PayPalSandbox({
    clientId: "fake",
    clientSecret: "fake",
    apiBase: "https://api-m.sandbox.paypal.com",
    vaultId: "FAKEVAULT",
    fetch: new FakePayPal({ defaultPayee: payee }).fetch,
  });
} else {
  const { PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_API_BASE, PAYPAL_PAYEE_EMAIL } = process.env;
  if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET || !PAYPAL_API_BASE) fail("set PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET and PAYPAL_API_BASE in .env (or pass --fake)");
  if (!PAYPAL_PAYEE_EMAIL) fail("set PAYPAL_PAYEE_EMAIL in .env to the sandbox app's business account email");
  const statePath = resolve(root, "spikes/paypal-vault/.state.json");
  const vaultId = existsSync(statePath) ? (JSON.parse(readFileSync(statePath, "utf8")) as { vaultId?: string }).vaultId : undefined;
  if (!vaultId) fail("no vaulted wallet yet: run the Vault spike's setup and token steps (spikes/paypal-vault/README.md)");
  payee = PAYPAL_PAYEE_EMAIL;
  paypal = new PayPalSandbox({ clientId: PAYPAL_CLIENT_ID, clientSecret: PAYPAL_CLIENT_SECRET, apiBase: PAYPAL_API_BASE, vaultId });
}

const { runs, ledger } = await runPaymentEvidence({ paypal, payee });
console.log(fake ? "PayPal stand-in (offline)\n" : "PayPal sandbox\n");
for (const { label, result } of runs) {
  const detail =
    result.status === "executed"
      ? `captured ${result.receipt.capture_id} (${result.receipt.status}) on order ${result.receipt.order_id}`
      : `${result.status} ${result.rule_ids.join(", ")}${result.prepared ? `, authorization ${result.prepared.reference} voided` : ""}`;
  console.log(`${label}\n  → ${detail}`);
}
console.log("\nFirewall ledger (evidence trail):");
for (const e of ledger) {
  const ids = Object.entries((e.external_ids as Record<string, string> | undefined) ?? {})
    .map(([k, v]) => `${k} ${v}`)
    .join("  ");
  console.log(`  #${e.seq} ${String(e.stage).padEnd(10)} ${e.system} ${e.reference}  ${ids}  commit ${e.commit_decision}`);
}
const ok =
  runs[0]!.result.status === "executed" &&
  runs[1]!.result.status === "BLOCK" &&
  ledger.some((e) => e.stage === "executed") &&
  ledger.some((e) => e.stage === "cancelled");
console.log(ok ? "\n✔ M6 evidence: one ALLOW captured, one BLOCK voided, both in the ledger." : "\n✖ Unexpected outcome.");
process.exitCode = ok ? 0 : 1;
