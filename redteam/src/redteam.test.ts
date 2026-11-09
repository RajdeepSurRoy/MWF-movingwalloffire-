import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuleBundle, getDefaultBundle, loadRuleBundle } from "@mwf/core";
import { loadCases, loadMerchants } from "@mwf/tests/harness";
import { describe, expect, it } from "vitest";
import { emptyLedger, legitPhrases, propose, record, similarity } from "./learn.js";
import { HELD_OUT_PARAPHRASES, PARAPHRASES, mutate } from "./mutate.js";
import { approve, backtest, enforce, withoutLearned, writeBundle } from "./rollout.js";
import { expand, runAll } from "./runner.js";

const all = loadCases();
const merchants = loadMerchants();
const legit = all.filter((c) => c.category === "legit");
const persuasion = all.filter((c) => c.category === "persuasion");
const train = persuasion.filter((c) => ["persuasion-1", "persuasion-2", "persuasion-3"].includes(c.id));
// Before anything was learned, whatever the repo's bundle has approved since.
const v1 = withoutLearned(getDefaultBundle());

describe("mutation engine", () => {
  it("makes 20+ variants per seed, each keeping the seed's ground truth", () => {
    const variants = mutate(persuasion[0]!, persuasion);
    expect(variants.length).toBeGreaterThanOrEqual(20);
    expect(new Set(variants.map((v) => v.case.id)).size).toBe(variants.length);
    for (const v of variants) expect(v.case.expected).toEqual(persuasion[0]!.expected);
  });

  it("is deterministic", () => {
    expect(mutate(persuasion[1]!, persuasion)).toEqual(mutate(persuasion[1]!, persuasion));
  });

  it("keeps the training and held-out wording apart", () => {
    expect(PARAPHRASES.filter((p) => HELD_OUT_PARAPHRASES.includes(p))).toEqual([]);
  });
});

describe("learning levels", () => {
  it("level 1: the same attack is recorded once", () => {
    const runs = runAll(expand(train.slice(0, 1)), v1, merchants);
    const ledger = emptyLedger();
    const first = record(ledger, runs, v1);
    expect(first.length).toBeGreaterThan(0);
    expect(record(ledger, runs, v1)).toEqual([]);
  });

  it("level 2/3: re-encoded variants of one claim share a fingerprint and a family", () => {
    const runs = runAll(expand(train.slice(0, 1)), v1, merchants);
    const ledger = emptyLedger();
    record(ledger, runs, v1);
    const encoded = ledger.entries.filter((e) => ["homoglyph", "upper", "spacing"].includes(e.mutation[0] ?? "") || e.mutation.length === 0);
    expect(new Set(encoded.map((e) => e.fingerprint)).size).toBe(1);
    expect(new Set(encoded.map((e) => e.family)).size).toBe(1);
  });

  it("level 3: near copies are similar, unrelated claims are not", () => {
    expect(similarity(["most", "popular", "this", "month"], ["most", "popular", "this", "week"])).toBeGreaterThan(0.5);
    expect(similarity(["most", "popular", "this", "month"], ["experts", "recommend"])).toBe(0);
  });
});

describe("the learning loop", () => {
  it("v1 bypass → candidate → clean backtest → approve (shadow) → enforce → v2 holds the seeds and their mutations", () => {
    const variants = expand(train);
    const runs1 = runAll(variants, v1, merchants);
    expect(runs1.filter((r) => r.bypass).length).toBeGreaterThan(0);

    const ledger = emptyLedger();
    record(ledger, runs1, v1);
    const candidate = propose(ledger.entries, legitPhrases(legit, v1))!;
    expect(candidate).not.toBeNull();

    const cases = [...legit.map((c) => ({ case: c, seed: c.id, mutation: [] })), ...variants];
    const draft = { id: candidate.id, description: candidate.description, state: "enforced" as const, phrases: candidate.phrases, fingerprints: candidate.fingerprints, learned: { families: candidate.families, backtest: { caught: 0, of: 0, legit_broken: 0, weakened: 0 }, approved_by: "test", approved_at: "2026-11-09T00:00:00.000Z" } };
    const test = backtest(v1, draft, cases, merchants);
    expect(test).toMatchObject({ legit_broken: 0, weakened: 0 });
    expect(test.caught).toBe(test.of);

    const v2 = approve(v1, candidate, test, "tester");
    expect(v2.version).not.toBe(v1.version);
    expect(v2.claim_rules.find((r) => r.id === candidate.id)?.state).toBe("shadow");
    // Shadow: same decisions, the would-be holds recorded.
    const shadowRuns = runAll(variants, v2, merchants);
    expect(shadowRuns.map((r) => r.result.actual)).toEqual(runs1.map((r) => r.result.actual));
    expect(shadowRuns.some((r) => r.result.shadow?.length)).toBe(true);

    const v3 = enforce(v2, candidate.id);
    const runs3 = runAll(variants, v3, merchants);
    expect(runs3.filter((r) => r.bypass)).toEqual([]);
    expect(runs3.every((r) => r.result.actual === "REVIEW" || r.result.actual === "BLOCK")).toBe(true);
    expect(runAll(cases.slice(0, legit.length), v3, merchants).every((r) => r.result.actual === "ALLOW")).toBe(true);
  });

  it("refuses to approve a candidate that would hold a legitimate purchase", () => {
    const candidate = { id: "LRN.CLAIM.BAD", description: "x", families: [], phrases: ["alkaline batteries"], fingerprints: [], entries: [] };
    const test = { caught: 1, of: 1, legit_total: 52, legit_broken: 3, weakened: 0, by_kind: {}, broken_cases: [], missed_cases: [] };
    expect(() => approve(v1, candidate, test, "tester")).toThrow(/cannot be approved/);
  });

  it("writes only the version and claim rules into the bundle file", () => {
    const dir = mkdtempSync(join(tmpdir(), "mwf-bundle-"));
    const path = join(dir, "bundle.json");
    const original = readFileSync(new URL("../../packages/core/rules/bundle.json", import.meta.url), "utf8");
    writeFileSync(path, original);
    const rule = { id: "LRN.CLAIM.T", description: "t", state: "shadow" as const, phrases: ["engineers choose"], fingerprints: [], learned: { families: [], backtest: { caught: 1, of: 1, legit_broken: 0, weakened: 0 }, approved_by: "t", approved_at: "2026-11-09T00:00:00.000Z" } };
    const next = RuleBundle.parse({ ...v1, version: "9.9.0", claim_rules: [rule] });
    writeBundle(path, next);
    const written = loadRuleBundle(path);
    expect(written.version).toBe("9.9.0");
    expect(written.claim_rules).toEqual([rule]);
    expect(written.text_rules).toEqual(v1.text_rules);
    const text = readFileSync(path, "utf8");
    expect(text.slice(0, text.indexOf('"claim_rules"')).replace("9.9.0", v1.version)).toBe(original.slice(0, original.indexOf('"claim_rules"')));

    // A sensor goes after the claim rules, its weights on one line; writing again replaces it.
    const sensor = { id: "SEN.PERSUASION.T", description: "t", state: "shadow" as const, model: { name: "x/y", revision: "0".repeat(40), file: "onnx/m.onnx", sha256: "c".repeat(64), pooling: "mean" as const, dim: 2 }, weights: [0.5, -0.25], bias: 0.1, threshold: 0.6, learned: { positives: 1, negatives: 1, calibration: { negatives: 1, above_threshold: 0, max_score: 0.5 }, backtest: { caught: 1, of: 1, legit_broken: 0, weakened: 0 }, approved_by: "t", approved_at: "2026-11-10T00:00:00.000Z" } };
    writeBundle(path, RuleBundle.parse({ ...next, claim_sensors: [sensor] }));
    writeBundle(path, RuleBundle.parse({ ...next, version: "9.10.0", claim_sensors: [{ ...sensor, state: "enforced" }] }));
    const again = loadRuleBundle(path);
    expect(again.claim_sensors).toEqual([{ ...sensor, state: "enforced" }]);
    expect(again.claim_rules).toEqual([rule]);
    expect(readFileSync(path, "utf8")).toContain('"weights": [0.5, -0.25]');
  });
});
