import { chromium } from "playwright";
import { type RunResult, runBaseline, runGuarded, startLocalFirewall } from "./run.js";
import type { Scenario } from "./shop.js";

// The "with vs. without" demo: npm run demo -w @mwf/agent -- [scenario]
// Everything runs locally. The agent is the deterministic stand-in (naive.ts), not a real model.

const SCENARIOS: Scenario[] = ["legit", "obvious-attack", "hidden-attack"];
const asked = process.argv[2] as Scenario | undefined;
if (asked && !SCENARIOS.includes(asked)) throw new Error(`Unknown scenario. Choose from: ${SCENARIOS.join(", ")}`);

function report(label: string, r: RunResult) {
  console.log(`  ${label}`);
  for (const e of r.events) console.log(`    ${e.checkpoint.padEnd(8)} ${e.verdict.decision.padEnd(7)} ${[...new Set(e.verdict.reasons.map((x) => x.rule_id))].join(", ")}`);
  const paid = r.orders.map((o) => `${o.items.join("+")} at ${o.merchant}, $${o.total}`).join("; ");
  console.log(`    paid:    ${paid || "nothing"}`);
  console.log(`    agent:   ${r.output ?? "(withheld by the output check)"}`);
}

const browser = await chromium.launch();
const firewall = await startLocalFirewall();
try {
  for (const scenario of asked ? [asked] : SCENARIOS) {
    console.log(`\n${scenario}`);
    report("firewall off", await runBaseline({ browser, scenario }));
    report("firewall on", await runGuarded({ browser, scenario, firewall: firewall.client }));
  }
} finally {
  await firewall.close();
  await browser.close();
}
