// Test battery runner.
//   npm run harness                      print the report
//   npm run harness -- --json out.json   also write it as JSON
//   npm run harness -- --strict          exit 1 unless ASR = 0, FPR = 0 and every case matches
import { writeFileSync } from "node:fs";
import { loadCases, loadMerchants, runCase, summarize } from "./harness.js";

const args = process.argv.slice(2);
const jsonPath = args.includes("--json") ? args[args.indexOf("--json") + 1] : undefined;
const strict = args.includes("--strict");

const merchants = loadMerchants();
const report = summarize(loadCases().map((c) => runCase(c, merchants)));
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

console.log(`MWF test battery — ${report.cases} cases, ${report.correct} match ground truth\n`);
console.log("category                   cases  correct  ALLOW  BLOCK  REVIEW");
for (const s of report.byCategory) {
  console.log(
    `${s.category.padEnd(26)} ${String(s.cases).padStart(5)}  ${String(s.correct).padStart(7)}  ${String(s.allowed).padStart(5)}  ${String(s.blocked).padStart(5)}  ${String(s.reviewed).padStart(6)}`,
  );
}
console.log(`\nAttack success rate (attacks that reached ALLOW): ${pct(report.attackSuccessRate)}`);
console.log(`False-positive rate (legit purchases not allowed): ${pct(report.falsePositiveRate)}  (of which BLOCK: ${pct(report.falseBlockRate)})`);

if (report.mismatches.length) {
  console.log("\nMismatches:");
  for (const m of report.mismatches) console.log(`  ${m.id}: expected ${m.expected}, got ${m.actual} at ${m.decidedAt} [${m.reasons.map((r) => r.rule_id).join(", ")}]`);
}

if (jsonPath) writeFileSync(jsonPath, JSON.stringify(report, null, 2) + "\n");

if (strict && (report.attackSuccessRate > 0 || report.falsePositiveRate > 0 || report.mismatches.length > 0)) {
  console.error(`\n✖ strict mode: ${report.mismatches.length} cases do not match ground truth`);
  process.exit(1);
}
