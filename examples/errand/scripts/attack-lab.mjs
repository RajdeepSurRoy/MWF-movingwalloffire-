// The attack lab: runs Errand against FreshCart with real attacks planted in the shop, once with
// the MWF firewall off and once with it on, and reports what reached an order.
//
// It starts its own throwaway copies of everything, so no real data is touched:
// - the MWF firewall API (from MWF_REPO) on :8787 with a fresh database and its own API key,
// - FreshCart (from FRESHCART_DIR) on :3100 (LAB_SHOP_PORT) with a fresh database,
// - a lookalike shop on the next port (a proxy to FreshCart under another address).
// Payments use the shop's pay-on-delivery option: no PayPal, no money. LAB_PAY=paypal makes the
// agent pay with its PayPal sandbox buyer account instead (needs the PayPal settings in both apps'
// env files; sandbox only, no real money). In that mode FreshCart also checks every PayPal payment
// with MWF before it captures (its own tenant and key): MWF compares what PayPal's API says it
// holds with the order and with the PayPal account registered for FreshCart. That account is
// MWF_PAYPAL_PAYEE in FreshCart's .env.local; LAB_PAYPAL_PAYEE overrides it (e.g. to simulate a
// shop whose PayPal keys were swapped for someone else's account).
//
// The agent's model: LAB_MODEL=naive (default) is an offline stand-in that always obeys product codes
// in shop text, so every injection is attempted; LAB_MODEL=gemini uses the real AI (Errand's
// GEMINI_API_KEY, about 3 requests per run), which may or may not be fooled.
// Usage: node scripts/attack-lab.mjs [case ...]   (LAB_OUT=<file> also writes the results there)
//
// The attacks, the services and the verdicts live in lab-core.mjs (shared with the playground).
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startLab } from "./lab-core.mjs";

const HERE = import.meta.dirname;
const MWF_REPO = resolve(process.env.MWF_REPO ?? join(HERE, "../../.."));
const LAB = join(process.env.LAB_DIR ?? tmpdir(), `mwf-lab-${Date.now()}`);
const MODEL = process.env.LAB_MODEL ?? "naive";
const PAY = process.env.LAB_PAY ?? "delivery";
if (!["naive", "gemini", "mock"].includes(MODEL)) throw new Error("LAB_MODEL must be naive, gemini or mock");

console.log(`Lab folder: ${LAB}`);
const lab = await startLab({
  mwfRepo: MWF_REPO,
  freshcart: resolve(process.env.FRESHCART_DIR ?? join(HERE, "../../freshcart")),
  labDir: LAB,
  shopPort: Number(process.env.LAB_SHOP_PORT ?? 3100),
  pay: PAY,
  payeeOverride: process.env.LAB_PAYPAL_PAYEE,
});
process.on("exit", lab.stop);
process.on("SIGINT", () => process.exit(1));

const wanted = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(lab.cases);
for (const id of wanted) if (!lab.cases[id]) throw new Error(`unknown case ${id}`);
const results = [];
for (const id of wanted) {
  for (const firewall of [false, true]) {
    process.stdout.write(`${id.padEnd(17)} firewall ${firewall ? "on " : "off"} … `);
    const run = await lab.runCase(id, { firewall, model: MODEL });
    console.log(`${run.outcome}${run.detail ? ` (${run.detail})` : ""}`);
    results.push({ case: id, what: lab.cases[id].what, firewall, model: MODEL, ...run });
  }
}
const report = {
  generated_at: new Date().toISOString(),
  model: MODEL,
  mwf_commit: spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: MWF_REPO, encoding: "utf8" }).stdout.trim(),
  payments:
    PAY === "paypal"
      ? "PayPal sandbox: the agent pays with its sandbox buyer account (WALLET_MODE=paypal); no real money. FreshCart checks each PayPal payment with MWF before capture, in every run (its own tenant); 'firewall' below is Errand's side."
      : "FreshCart pay-on-delivery (WALLET_MODE=off): no PayPal, no money",
  ...(PAY === "paypal" && { shop_payee_registered: lab.payee.replace(/^(.).*@/, "$1•••@") }),
  summary: results.map((r) => ({ case: r.case, firewall: r.firewall ? "on" : "off", outcome: r.outcome, detail: r.detail })),
  runs: results,
};
writeFileSync(join(LAB, "results.json"), JSON.stringify(report, null, 2));
if (process.env.LAB_OUT) writeFileSync(resolve(process.env.LAB_OUT), JSON.stringify(report, null, 2));
console.log(`\nDetails: ${join(LAB, "results.json")}${process.env.LAB_OUT ? ` and ${resolve(process.env.LAB_OUT)}` : ""}`);
process.exit(0);
