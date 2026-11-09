import { readFileSync, writeFileSync } from "node:fs";
import { type ClaimSensor, type MerchantRecord, RuleBundle, type SensorVectors } from "@mwf/core";
import { runCase } from "@mwf/tests/harness";
import type { Candidate } from "./learn.js";
import { mutationKind } from "./mutate.js";
import { type Run, isBypass } from "./runner.js";
import type { Variant } from "./mutate.js";

// Backtest and rollout. A candidate goes candidate → shadow → enforced. Each step is a person's
// decision and bumps the bundle version, so every decision names the rules it was made with.
// A candidate that holds a single legitimate purchase, or softens any decision, is refused.

export type ClaimRule = RuleBundle["claim_rules"][number];
// What the red team rolls out: a learned claim rule (LRN.*) or an embedding sensor (SEN.*).
export type Learned = ClaimRule | ClaimSensor;
const isSensor = (x: Learned): x is ClaimSensor => x.id.startsWith("SEN.");

const strictness = { ALLOW: 0, REVIEW: 1, BLOCK: 2 } as const;

export interface Backtest {
  // Attacks the current bundle lets through that the candidate holds.
  caught: number;
  of: number;
  legit_total: number;
  legit_broken: number;
  // Cases whose decision would get softer. Learned rules only add REVIEW, so this must be 0.
  weakened: number;
  by_kind: Record<string, { caught: number; of: number }>;
  broken_cases: string[];
  missed_cases: string[];
}

// Runs every case with the current bundle and with the candidate enforced. A sensor needs the
// vectors of every claim in the cases.
export function backtest(base: RuleBundle, rule: Learned, cases: Variant[], merchants: MerchantRecord[], sensors?: SensorVectors): Backtest {
  const trial = withRule(base, { ...rule, state: "enforced" }, false);
  const out: Backtest = { caught: 0, of: 0, legit_total: 0, legit_broken: 0, weakened: 0, by_kind: {}, broken_cases: [], missed_cases: [] };
  for (const v of cases) {
    const before = runCase(v.case, merchants, undefined, base, sensors);
    const after = runCase(v.case, merchants, undefined, trial, sensors);
    if (strictness[after.actual] < strictness[before.actual]) out.weakened++;
    if (v.case.category === "legit") {
      out.legit_total++;
      if (before.actual === "ALLOW" && after.actual !== "ALLOW") {
        out.legit_broken++;
        out.broken_cases.push(v.case.id);
      }
      continue;
    }
    if (!isBypass(v.case, before)) continue;
    const kind = v.mutation.length ? mutationKind(v.mutation) : "seed";
    const k = (out.by_kind[kind] ??= { caught: 0, of: 0 });
    out.of++;
    k.of++;
    if (after.actual !== "ALLOW") {
      out.caught++;
      k.caught++;
    } else out.missed_cases.push(v.case.id);
  }
  return out;
}

// The bundle as it was before anything was learned: the demo and tests start the loop here,
// whatever the repo's bundle has already learned.
export const withoutLearned = (bundle: RuleBundle): RuleBundle => RuleBundle.parse({ ...bundle, claim_rules: [], claim_sensors: [] });

export const approvable = (b: Backtest) => b.legit_broken === 0 && b.weakened === 0 && b.caught > 0;

function bump(version: string): string {
  const [major, minor] = version.split(".").map(Number);
  return `${major}.${minor! + 1}.0`;
}

// A new bundle with `rule` added or replaced. `release`: bump the version (a real rollout step).
export function withRule(bundle: RuleBundle, rule: Learned, release = true): RuleBundle {
  const version = release ? bump(bundle.version) : bundle.version;
  if (isSensor(rule)) return RuleBundle.parse({ ...bundle, version, claim_sensors: [...bundle.claim_sensors.filter((r) => r.id !== rule.id), rule] });
  return RuleBundle.parse({ ...bundle, version, claim_rules: [...bundle.claim_rules.filter((r) => r.id !== rule.id), rule] });
}

// Step 1 for a sensor: as for a rule, with the trained sensor in place of a candidate.
export function approveSensor(bundle: RuleBundle, sensor: ClaimSensor, test: Backtest, by: string, now = new Date()): RuleBundle {
  if (!approvable(test)) {
    throw new Error(`${sensor.id} cannot be approved: it holds ${test.legit_broken} legitimate purchases, softens ${test.weakened} decisions and catches ${test.caught} attacks`);
  }
  if (!by.trim()) throw new Error("approval needs the approver's name");
  const backtest = { caught: test.caught, of: test.of, legit_broken: test.legit_broken, weakened: test.weakened };
  return withRule(bundle, { ...sensor, state: "shadow", learned: { ...sensor.learned, backtest, approved_by: by.trim(), approved_at: now.toISOString() } });
}

// Step 1: a person approves a candidate whose backtest is clean. It runs in shadow.
export function approve(bundle: RuleBundle, candidate: Candidate, test: Backtest, by: string, now = new Date()): RuleBundle {
  if (!approvable(test)) {
    throw new Error(`${candidate.id} cannot be approved: it holds ${test.legit_broken} legitimate purchases, softens ${test.weakened} decisions and catches ${test.caught} attacks`);
  }
  if (!by.trim()) throw new Error("approval needs the approver's name");
  return withRule(bundle, {
    id: candidate.id,
    description: candidate.description,
    state: "shadow",
    phrases: candidate.phrases,
    fingerprints: candidate.fingerprints,
    learned: {
      families: candidate.families,
      backtest: { caught: test.caught, of: test.of, legit_broken: test.legit_broken, weakened: test.weakened },
      approved_by: by.trim(),
      approved_at: now.toISOString(),
    },
  });
}

// Step 2: after it has run in shadow, a person enforces it.
export function enforce(bundle: RuleBundle, id: string): RuleBundle {
  const rule: Learned | undefined = bundle.claim_rules.find((r) => r.id === id) ?? bundle.claim_sensors.find((r) => r.id === id);
  if (!rule) throw new Error(`no rule ${id} in bundle ${bundle.version}`);
  if (rule.state === "enforced") throw new Error(`${id} is already enforced`);
  return withRule(bundle, { ...rule, state: "enforced" });
}

// What a shadow rule would have changed in a run: the cases it would have held.
export const shadowHits = (runs: Run[]) => runs.filter((r) => r.result.actual === "ALLOW" && (r.result.shadow?.length ?? 0) > 0);

// Writes the bundle's version, claim rules and sensors into the bundle file, leaving the
// hand-written rest of the file as it is. The learned parts are the file's last keys.
export function writeBundle(path: string, bundle: RuleBundle): void {
  const text = readFileSync(path, "utf8");
  const at = text.lastIndexOf('"claim_rules"');
  if (at < 0) throw new Error(`${path} has no claim_rules`);
  const json = (v: unknown) => JSON.stringify(v, null, 2).replace(/\n/g, "\n  ");
  // A sensor's weights on one line, so the file stays readable.
  const sensors = json(bundle.claim_sensors).replace(/"weights": \[[^\]]*\]/g, (m) => m.replace(/\s+/g, " ").replace("[ ", "[").replace(" ]", "]"));
  const tail = `"claim_rules": ${json(bundle.claim_rules)}${bundle.claim_sensors.length ? `,\n  "claim_sensors": ${sensors}` : ""}\n}\n`;
  const next = text.slice(0, at).replace(/"version": "\d+\.\d+\.\d+"/, `"version": "${bundle.version}"`) + tail;
  RuleBundle.parse(JSON.parse(next));
  writeFileSync(path, next);
}
