import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type DecisionResult, type MerchantRecord, type TestCase, TestCase as TestCaseSchema, checkAction, checkCommit, hashCanonical } from "@mwf/core";

export const FIXTURES_DIR = join(import.meta.dirname, "..", "fixtures");

export function loadMerchants(dir = FIXTURES_DIR): MerchantRecord[] {
  return JSON.parse(readFileSync(join(dir, "merchants.json"), "utf8")) as MerchantRecord[];
}

export function loadCases(dir = FIXTURES_DIR): TestCase[] {
  const cases: TestCase[] = [];
  for (const sub of ["legit", "attacks"]) {
    for (const file of readdirSync(join(dir, sub)).filter((f) => f.endsWith(".json")).sort()) {
      const raw = JSON.parse(readFileSync(join(dir, sub, file), "utf8")) as unknown[];
      raw.forEach((c, i) => {
        const parsed = TestCaseSchema.safeParse(c);
        if (!parsed.success) throw new Error(`${sub}/${file}[${i}]: ${parsed.error.message}`);
        cases.push(parsed.data);
      });
    }
  }
  return cases;
}

export interface CaseResult {
  id: string;
  category: TestCase["category"];
  expected: TestCase["expected"]["decision"];
  actual: DecisionResult["decision"];
  decidedAt: "action" | "commit";
  reasons: DecisionResult["reasons"];
}

// Runs one case through the decision logic only: no network, no PayPal.
// The check runs first; only an ALLOW goes on to commit, as in production.
export function runCase(c: TestCase, merchants: MerchantRecord[] = loadMerchants()): CaseResult {
  const base = { id: c.id, category: c.category, expected: c.expected.decision };
  const check = checkAction({ mandate: c.mandate, context: c.context, action: c.action, now: new Date(c.now), merchants });
  if (check.decision !== "ALLOW") return { ...base, actual: check.decision, decidedAt: "action", reasons: check.reasons };

  const approvedActionHash = hashCanonical(c.action);
  let commit = checkCommit({ approvedActionHash, executedAction: c.commit_action ?? c.action, alreadyCommitted: false });
  if (c.replay_commit && commit.decision === "ALLOW") {
    commit = checkCommit({ approvedActionHash, executedAction: c.action, alreadyCommitted: true });
  }
  return { ...base, actual: commit.decision, decidedAt: "commit", reasons: commit.reasons };
}

export interface CategoryStats {
  category: TestCase["category"];
  cases: number;
  correct: number;
  allowed: number;
  blocked: number;
  reviewed: number;
}

export interface Report {
  cases: number;
  correct: number;
  // Share of attacks that ended in ALLOW: the attack got its payment through.
  attackSuccessRate: number;
  // Share of legitimate purchases that did not end in ALLOW.
  falsePositiveRate: number;
  falseBlockRate: number;
  byCategory: CategoryStats[];
  mismatches: CaseResult[];
}

export function summarize(results: CaseResult[]): Report {
  const byCategory = new Map<string, CategoryStats>();
  for (const r of results) {
    const s = byCategory.get(r.category) ?? { category: r.category, cases: 0, correct: 0, allowed: 0, blocked: 0, reviewed: 0 };
    s.cases++;
    if (r.actual === r.expected) s.correct++;
    if (r.actual === "ALLOW") s.allowed++;
    else if (r.actual === "BLOCK") s.blocked++;
    else s.reviewed++;
    byCategory.set(r.category, s);
  }
  const attacks = results.filter((r) => r.category !== "legit");
  const legit = results.filter((r) => r.category === "legit");
  const rate = (n: number, d: number) => (d === 0 ? 0 : n / d);
  return {
    cases: results.length,
    correct: results.filter((r) => r.actual === r.expected).length,
    attackSuccessRate: rate(attacks.filter((r) => r.actual === "ALLOW").length, attacks.length),
    falsePositiveRate: rate(legit.filter((r) => r.actual !== "ALLOW").length, legit.length),
    falseBlockRate: rate(legit.filter((r) => r.actual === "BLOCK").length, legit.length),
    byCategory: [...byCategory.values()].sort((a, b) => (a.category === "legit" ? -1 : b.category === "legit" ? 1 : a.category.localeCompare(b.category))),
    mismatches: results.filter((r) => r.actual !== r.expected),
  };
}
