import { readFileSync, writeFileSync } from "node:fs";
import { type MerchantRecord, RuleBundle } from "@mwf/core";
import { runCase } from "@mwf/tests/harness";
import type { Candidate } from "./learn.js";
import { mutationKind } from "./mutate.js";
import { type Run, isBypass } from "./runner.js";
import type { Variant } from "./mutate.js";

// Backtest and rollout. A candidate goes candidate → shadow → enforced. Each step is a person's
// decision and bumps the bundle version, so every decision names the rules it was made with.
// A candidate that holds a single legitimate purchase, or softens any decision, is refused.

export type ClaimRule = RuleBundle["claim_rules"][number];

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

// Runs every case with the current bundle and with the candidate enforced.
export function backtest(base: RuleBundle, rule: ClaimRule, cases: Variant[], merchants: MerchantRecord[]): Backtest {
  const trial = withRule(base, { ...rule, state: "enforced" }, false);
  const out: Backtest = { caught: 0, of: 0, legit_total: 0, legit_broken: 0, weakened: 0, by_kind: {}, broken_cases: [], missed_cases: [] };
  for (const v of cases) {
    const before = runCase(v.case, merchants, undefined, base);
    const after = runCase(v.case, merchants, undefined, trial);
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

export const approvable = (b: Backtest) => b.legit_broken === 0 && b.weakened === 0 && b.caught > 0;

function bump(version: string): string {
  const [major, minor] = version.split(".").map(Number);
  return `${major}.${minor! + 1}.0`;
}

// A new bundle with `rule` added or replaced. `release`: bump the version (a real rollout step).
export function withRule(bundle: RuleBundle, rule: ClaimRule, release = true): RuleBundle {
  const claim_rules = [...bundle.claim_rules.filter((r) => r.id !== rule.id), rule];
  return RuleBundle.parse({ ...bundle, version: release ? bump(bundle.version) : bundle.version, claim_rules });
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
  const rule = bundle.claim_rules.find((r) => r.id === id);
  if (!rule) throw new Error(`no rule ${id} in bundle ${bundle.version}`);
  if (rule.state === "enforced") throw new Error(`${id} is already enforced`);
  return withRule(bundle, { ...rule, state: "enforced" });
}

// What a shadow rule would have changed in a run: the cases it would have held.
export const shadowHits = (runs: Run[]) => runs.filter((r) => r.result.actual === "ALLOW" && (r.result.shadow?.length ?? 0) > 0);

// Writes the bundle's version and claim rules into the bundle file, leaving the hand-written
// rest of the file as it is.
export function writeBundle(path: string, bundle: RuleBundle): void {
  const text = readFileSync(path, "utf8");
  const at = text.lastIndexOf('"claim_rules"');
  if (at < 0) throw new Error(`${path} has no claim_rules`);
  const rules = JSON.stringify(bundle.claim_rules, null, 2).replace(/\n/g, "\n  ");
  const next = text.slice(0, at).replace(/"version": "\d+\.\d+\.\d+"/, `"version": "${bundle.version}"`) + `"claim_rules": ${rules}\n}\n`;
  RuleBundle.parse(JSON.parse(next));
  writeFileSync(path, next);
}
