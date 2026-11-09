// Red team: find bypasses, learn rules from them, roll the rules out.
//
//   npm run redteam -- demo                       the whole loop in memory; writes nothing
//   npm run redteam -- run [--category persuasion]  mutate the attack fixtures, record bypasses
//   npm run redteam -- learn                      propose a rule from the ledger and backtest it
//   npm run redteam -- sensor                     train the persuasion embedding sensor, backtest it
//   npm run redteam -- approve <rule-id> --by <name>   candidate → shadow (bumps the bundle)
//   npm run redteam -- enforce <rule-id> --by <name>   shadow → enforced (bumps the bundle)
//
// The ledger and candidates live in redteam/data/. approve and enforce edit
// packages/core/rules/bundle.json; commit it like any other rule change.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type ClaimSensor, type RuleBundle, type SensorVectors, type TestCase, getDefaultBundle, hashCanonical, loadRuleBundle } from "@mwf/core";
import { loadEmbedder } from "@mwf/sensors";
import { loadCases, loadMerchants } from "@mwf/tests/harness";
import { type Candidate, type Ledger, emptyLedger, legitPhrases, propose, record } from "./learn.js";
import { HELD_OUT_PARAPHRASES, type Variant, mutationKind } from "./mutate.js";
import { type Backtest, approve, approveSensor, backtest, enforce, shadowHits, withoutLearned, writeBundle } from "./rollout.js";
import { caseTexts, negatives, trainSensor, vectorsFor } from "./sensor.js";
import { type Run, expand, runAll } from "./runner.js";

const ROOT = resolve(import.meta.dirname, "../..");
const DATA = join(ROOT, "redteam", "data");
const LEDGER = join(DATA, "ledger.json");
const CANDIDATES = join(DATA, "candidates.json");
const BENIGN = join(DATA, "benign.txt");
const COPY = join(DATA, "product-copy.txt");
const SENSOR = join(DATA, "sensor-candidate.json");

const BUNDLE = join(ROOT, "packages", "core", "rules", "bundle.json");

const args = process.argv.slice(2);
const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const readJson = <T>(path: string, fallback: T): T => (existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : fallback);
const writeJson = (path: string, value: unknown) => {
  mkdirSync(DATA, { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
};

const merchants = loadMerchants();
const all = loadCases();
const legit = all.filter((c) => c.category === "legit");
const attacks = all.filter((c) => c.category !== "legit");
// Attacks kept out of learning, to measure what a learned rule or sensor does with new wording.
const fresh = loadCases(undefined, ["fresh"]);
const benign = existsSync(BENIGN) ? readFileSync(BENIGN, "utf8").split(/\r?\n/).filter((l) => l.trim() && !l.startsWith("#")) : [];
const pct = (n: number, d: number) => (d === 0 ? "—" : `${((100 * n) / d).toFixed(0)}%`);

function table(runs: Run[]) {
  const rows = new Map<string, { n: number; bypass: number }>();
  for (const r of runs) {
    const kind = r.mutation.length ? mutationKind(r.mutation) : "seed";
    const row = rows.get(kind) ?? { n: 0, bypass: 0 };
    row.n++;
    if (r.bypass) row.bypass++;
    rows.set(kind, row);
  }
  console.log("    kind          cases  got through");
  for (const [kind, row] of rows) console.log(`    ${kind.padEnd(13)} ${String(row.n).padStart(5)}  ${String(row.bypass).padStart(5)}  ${pct(row.bypass, row.n)}`);
  const n = runs.filter((r) => r.bypass).length;
  console.log(`    total         ${String(runs.length).padStart(5)}  ${String(n).padStart(5)}  ${pct(n, runs.length)}`);
}

function printBacktest(b: Backtest) {
  console.log(`    catches ${b.caught} of ${b.of} attacks that got through; holds ${b.legit_broken} of ${b.legit_total} legitimate purchases; softens ${b.weakened} decisions`);
  for (const [kind, k] of Object.entries(b.by_kind)) console.log(`      ${kind.padEnd(13)} ${k.caught}/${k.of}`);
  if (b.broken_cases.length) console.log(`    legitimate purchases it would hold: ${b.broken_cases.join(", ")}`);
}

const backtestSet = (variants: Variant[]): Variant[] => [
  ...legit.map((c) => ({ case: c, seed: c.id, mutation: [] })),
  ...attacks.filter((c) => !variants.some((v) => v.case.id === c.id)).map((c) => ({ case: c, seed: c.id, mutation: [] })),
  ...variants,
];

async function demo() {
  // Starts from the repo's bundle with its learned rules taken out, so the loop is shown from
  // the beginning even after rules have been approved.
  const v1 = withoutLearned(getDefaultBundle());
  const persuasion = attacks.filter((c) => c.category === "persuasion");
  const trainIds = (flag("--train") ?? "persuasion-1,persuasion-2,persuasion-3,persuasion-4,persuasion-5").split(",");
  const train = persuasion.filter((c) => trainIds.includes(c.id));
  const heldOut = persuasion.filter((c) => !trainIds.includes(c.id));
  const trainVariants = expand(train);
  // Held-out seeds are mutated among themselves and with the held-out wording, so no claim the
  // learner saw reaches them.
  const heldVariants = expand(heldOut, HELD_OUT_PARAPHRASES);

  console.log(`MWF red team — learning loop demo (bundle ${v1.version} without its learned rules; nothing is written)\n`);
  console.log(`1. Attack: ${train.length} persuasion seeds, ${trainVariants.length - train.length} mutations, against bundle ${v1.version}`);
  const runs1 = runAll(trainVariants, v1, merchants);
  table(runs1);

  const ledger = emptyLedger();
  const added = record(ledger, runs1, v1);
  const families = new Set(added.map((e) => e.family));
  const fps = new Set(added.map((e) => e.fingerprint).filter(Boolean));
  console.log(`\n2. Ledger: ${added.length} bypasses → ${fps.size} claim fingerprints (level 2) → ${families.size} families (level 3)`);
  const example = added[0];
  if (example) console.log(`    e.g. ${example.case_id}: item ${example.root.sku} named in "${example.root.excerpt}"`);

  const candidate = propose(ledger.entries, legitPhrases(legit, v1, benign));
  if (!candidate) return console.log("\nNo candidate: no bypass has a root cause the templates explain.");
  console.log(`\n3. Candidate rule ${candidate.id} (level 4), REVIEW only`);
  console.log(`    phrases: ${candidate.phrases.map((p) => `"${p}"`).join(", ")}`);
  console.log(`    fingerprints of known claims: ${candidate.fingerprints.length}`);

  const rule = { id: candidate.id, description: candidate.description, state: "enforced" as const, phrases: candidate.phrases, fingerprints: candidate.fingerprints, learned: { families: candidate.families, backtest: { caught: 0, of: 0, legit_broken: 0, weakened: 0 }, approved_by: "backtest", approved_at: new Date().toISOString() } };
  const test = backtest(v1, rule, backtestSet(trainVariants), merchants);
  console.log(`\n4. Backtest over ${legit.length} legitimate purchases, every attack fixture (held-out seeds too) and the mutations:`);
  printBacktest(test);

  let v2: RuleBundle;
  try {
    v2 = approve(v1, candidate, test, "demo");
  } catch (e) {
    return console.log(`\n✖ ${(e as Error).message}`);
  }
  const shadowRuns = runAll(trainVariants, v2, merchants);
  console.log(`\n5. Approved → bundle ${v2.version}, rule in shadow: decisions unchanged (${shadowRuns.filter((r) => r.bypass).length} still through), ${shadowHits(shadowRuns).length} would be held`);

  const v3 = enforce(v2, candidate.id);
  console.log(`\n6. Enforced → bundle ${v3.version}. The seeds and their mutations again:`);
  const runs3 = runAll(trainVariants, v3, merchants);
  table(runs3);

  console.log(`\n7. Never seen: ${heldOut.length} other persuasion seeds and their ${heldVariants.length - heldOut.length} mutations`);
  console.log(`    bundle ${v1.version}:`);
  table(runAll(heldVariants, v1, merchants));
  console.log(`    bundle ${v3.version}:`);
  table(runAll(heldVariants, v3, merchants));

  const legitV3 = legit.map((c) => runAll([{ case: c, seed: c.id, mutation: [] }], v3, merchants)[0]!);
  const fp = legitV3.filter((r) => r.result.actual !== "ALLOW").length;
  console.log(`\n8. Legitimate purchases held by bundle ${v3.version}: ${fp} of ${legit.length}`);
  const ok = runs3.filter((r) => r.bypass).length === 0 && fp === 0;
  console.log(ok ? `\n✔ The seeds bypass ${v1.version}; ${v3.version} holds them and all their mutations, and no legitimate purchase.` : "\n✖ The learned rule does not hold every seed and mutation.");
  process.exitCode = ok ? 0 : 1;
  if (!ok || args.includes("--no-sensor")) return;

  // Level 3 with embeddings: the phrases above do not reach new wording; a sensor reads meaning.
  const embedder = await loadEmbedder();
  const positives = caseTexts(runs1.filter((r) => r.bypass).map((r) => r.case), v1);
  const { sensor } = await trainSensor(embedder, positives, negatives(COPY, BENIGN), "SEN.PERSUASION.DEMO");
  const cal = sensor.learned.calibration;
  console.log(`\n9. Embedding sensor ${sensor.id} (level 3), REVIEW only: ${embedder.model.name} (${embedder.model.sha256.slice(0, 12)}…) + logistic regression`);
  console.log(`    trained on ${sensor.learned.positives} attack claims and ${sensor.learned.negatives} ordinary texts; threshold ${sensor.threshold}, above all ${cal.negatives} held-out ordinary texts (highest ${cal.max_score})`);
  const everything = [...legit, ...attacks, ...trainVariants.map((v) => v.case), ...heldVariants.map((v) => v.case)];
  const vectors = await vectorsFor(embedder, everything, v1);
  // On its own, against the bundle with nothing learned, so the backtest shows what it adds.
  const stest = backtest(v1, sensor, backtestSet(trainVariants), merchants, vectors);
  printBacktest(stest);
  let v5: RuleBundle;
  try {
    v5 = enforce(approveSensor(v3, sensor, stest, "demo"), sensor.id);
  } catch (e) {
    process.exitCode = 1;
    return console.log(`\n✖ ${(e as Error).message}`);
  }
  console.log(`\n10. Approved and enforced → bundle ${v5.version}. Never seen, again:`);
  console.log(`    bundle ${v3.version} (learned phrases):`);
  table(runAll(heldVariants, v3, merchants, vectors));
  console.log(`    bundle ${v5.version} (learned phrases + sensor):`);
  const runs5 = runAll(heldVariants, v5, merchants, vectors);
  table(runs5);
  const fp5 = legit.filter((c) => runAll([{ case: c, seed: c.id, mutation: [] }], v5, merchants, vectors)[0]!.result.actual !== "ALLOW").length;
  console.log(`\n11. Legitimate purchases held by bundle ${v5.version}: ${fp5} of ${legit.length}`);
  const held5 = heldVariants.length - runs5.filter((r) => r.bypass).length;
  console.log(fp5 === 0 ? `\n✔ With the sensor, ${held5} of ${heldVariants.length} never-seen attacks are held, and no legitimate purchase.` : "\n✖ The sensor holds a legitimate purchase.");
  process.exitCode = fp5 === 0 ? 0 : 1;
}

function run() {
  const bundle = getDefaultBundle();
  const category = flag("--category");
  const seeds = attacks.filter((c) => !category || c.category === category);
  const variants = expand(seeds);
  console.log(`Red team run: ${seeds.length} seeds, ${variants.length - seeds.length} mutations, bundle ${bundle.version}\n`);
  const runs = runAll(variants, bundle, merchants);
  table(runs);
  const ledger = readJson<Ledger>(LEDGER, emptyLedger());
  const added = record(ledger, runs, bundle);
  writeJson(LEDGER, ledger);
  const unexplained = added.filter((e) => e.root.template === "unexplained");
  console.log(`\n${added.length} new bypasses recorded in redteam/data/ledger.json (${ledger.entries.length} in all)`);
  if (unexplained.length) console.log(`${unexplained.length} have no root-cause template yet: ${unexplained.map((e) => e.case_id).join(", ")}`);
}

function variantsOfLedger(ledger: Ledger): Variant[] {
  const seeds = attacks.filter((c) => ledger.entries.some((e) => e.seed === c.id));
  return expand(seeds);
}

function learn() {
  const bundle = getDefaultBundle();
  const ledger = readJson<Ledger>(LEDGER, emptyLedger());
  const live = ledger.entries.filter((e) => !bundle.claim_rules.some((r) => r.learned.families.includes(e.family)));
  const candidate = propose(live, legitPhrases(legit, bundle, benign));
  if (!candidate) return console.log("Nothing to learn: no open bypass has a root cause the templates explain.");
  const rule = { id: candidate.id, description: candidate.description, state: "enforced" as const, phrases: candidate.phrases, fingerprints: candidate.fingerprints, learned: { families: candidate.families, backtest: { caught: 0, of: 0, legit_broken: 0, weakened: 0 }, approved_by: "backtest", approved_at: new Date().toISOString() } };
  const test = backtest(bundle, rule, backtestSet(variantsOfLedger(ledger)), merchants);
  const candidates = readJson<(Candidate & { backtest: Backtest })[]>(CANDIDATES, []).filter((c) => c.id !== candidate.id);
  candidates.push({ ...candidate, backtest: test });
  writeJson(CANDIDATES, candidates);
  console.log(`Candidate ${candidate.id}: ${candidate.phrases.length} phrases, ${candidate.fingerprints.length} fingerprints, from ${candidate.families.length} families`);
  printBacktest(test);
  console.log(`\nApprove with: npm run redteam -- approve ${candidate.id} --by <your name>`);
}

// The cases a sensor is trained and backtested on. Trained on the ledger's seeds and their
// variants; backtested on those, the held-out wording, and the fresh attacks
// (tests/fixtures/fresh): persuasion in wording no rule or sensor has learned from.
async function sensorSet(bundle: RuleBundle) {
  const ledger = readJson<Ledger>(LEDGER, emptyLedger());
  const seeds = attacks.filter((c) => ledger.entries.some((e) => e.seed === c.id));
  const known = expand(seeds);
  const unseen = [...expand(seeds, HELD_OUT_PARAPHRASES), ...expand(fresh, HELD_OUT_PARAPHRASES)].filter((v) => !known.some((k) => k.case.id === v.case.id));
  const embedder = await loadEmbedder();
  const cases = [...legit, ...attacks, ...known.map((v) => v.case), ...unseen.map((v) => v.case)];
  const vectors: SensorVectors = await vectorsFor(embedder, cases, bundle);
  return { embedder, known, unseen, vectors, set: [...backtestSet(known), ...unseen] };
}

async function sensorCmd() {
  const bundle = loadRuleBundle(BUNDLE);
  const { embedder, known, vectors, set } = await sensorSet(bundle);
  // Trained on the attacks the ledger knows; the held-out wording is only in the backtest.
  const positives = caseTexts(known.map((v) => v.case).filter((c) => c.expected.decision !== "ALLOW"), bundle);
  const draft = await trainSensor(embedder, positives, negatives(COPY, BENIGN), "SEN.PERSUASION.X");
  const id = `SEN.PERSUASION.${hashCanonical(draft.sensor.weights).slice(0, 8).toUpperCase()}`;
  const sensor: ClaimSensor = { ...draft.sensor, id };
  const test = backtest(bundle, sensor, set, merchants, vectors);
  writeJson(SENSOR, { sensor, backtest: test } satisfies { sensor: ClaimSensor; backtest: Backtest });
  const cal = sensor.learned.calibration;
  console.log(`Sensor ${id}: ${embedder.model.name} + logistic regression, ${sensor.learned.positives} attack claims, ${sensor.learned.negatives} ordinary texts`);
  console.log(`threshold ${sensor.threshold}: above all ${cal.negatives} held-out ordinary texts (highest ${cal.max_score})`);
  console.log(`Backtest against bundle ${bundle.version}:`);
  printBacktest(test);
  console.log(`\nApprove with: npm run redteam -- approve ${id} --by <your name>`);
}

async function approveSensorCmd(id: string, by: string) {
  const saved = readJson<{ sensor: ClaimSensor } | null>(SENSOR, null);
  if (saved?.sensor.id !== id) throw new Error(`no sensor ${id} in redteam/data/sensor-candidate.json`);
  const bundle = loadRuleBundle(BUNDLE);
  const { vectors, set } = await sensorSet(bundle);
  const test = backtest(bundle, saved.sensor, set, merchants, vectors);
  printBacktest(test);
  const next = approveSensor(bundle, saved.sensor, test, by);
  writeBundle(BUNDLE, next);
  console.log(`\n${id} approved by ${by}: bundle ${bundle.version} → ${next.version}, sensor in shadow. Enforce with: npm run redteam -- enforce ${id} --by <name>`);
}

async function approveCmd() {
  const id = args[1];
  const by = flag("--by");
  if (!id || !by) throw new Error("usage: approve <rule-id> --by <name>");
  if (id.startsWith("SEN.")) return approveSensorCmd(id, by);
  const candidate = readJson<Candidate[]>(CANDIDATES, []).find((c) => c.id === id);
  if (!candidate) throw new Error(`no candidate ${id} in redteam/data/candidates.json`);
  const bundle = loadRuleBundle(BUNDLE);
  const ledger = readJson<Ledger>(LEDGER, emptyLedger());
  const rule = { id: candidate.id, description: candidate.description, state: "enforced" as const, phrases: candidate.phrases, fingerprints: candidate.fingerprints, learned: { families: candidate.families, backtest: { caught: 0, of: 0, legit_broken: 0, weakened: 0 }, approved_by: by, approved_at: new Date().toISOString() } };
  // The backtest runs again now, against the bundle as it is today.
  const test = backtest(bundle, rule, backtestSet(variantsOfLedger(ledger)), merchants);
  printBacktest(test);
  const next = approve(bundle, candidate, test, by);
  writeBundle(BUNDLE, next);
  console.log(`\n${id} approved by ${by}: bundle ${bundle.version} → ${next.version}, rule in shadow. Enforce with: npm run redteam -- enforce ${id} --by <name>`);
}

function enforceCmd() {
  const id = args[1];
  const by = flag("--by");
  if (!id || !by) throw new Error("usage: enforce <rule-id> --by <name>");
  const bundle = loadRuleBundle(BUNDLE);
  const next = enforce(bundle, id);
  writeBundle(BUNDLE, next);
  console.log(`${id} enforced by ${by}: bundle ${bundle.version} → ${next.version}`);
}

const commands: Record<string, () => void | Promise<void>> = { demo, run, learn, sensor: sensorCmd, approve: approveCmd, enforce: enforceCmd };
const command = commands[args[0] ?? ""];
if (!command) {
  console.error(`usage: npm run redteam -- <${Object.keys(commands).join("|")}>`);
  process.exitCode = 1;
} else {
  try {
    await command();
  } catch (e) {
    console.error(`✖ ${(e as Error).message}`);
    process.exitCode = 1;
  }
}

export type { TestCase };
