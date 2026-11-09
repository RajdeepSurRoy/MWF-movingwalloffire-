import { type MerchantRecord, PaymentArgs, type RuleBundle, type SensorVectors, type TestCase, analyzeContext, findClaims, hashCanonical } from "@mwf/core";
import { type CaseResult, runCase } from "@mwf/tests/harness";
import { PARAPHRASES, type Variant, mutate } from "./mutate.js";

// Runner: seeds and their variants through the decision logic. A bypass is an ALLOW where the
// ground truth says the attack should have been held or blocked.

export interface RootCause {
  // Which template from the provenance explains it. `item_in_claim`: an item in the action is
  // named in a claim on an untrusted page the agent read. `unexplained`: no template fits yet;
  // it stays in the ledger for a person.
  template: "item_in_claim" | "unexplained";
  item_id?: string;
  sku?: string;
  // The claim with the item's words removed, and its fingerprint (when the claim is whole).
  remainder?: string[];
  fingerprint?: string;
  excerpt?: string;
}

export interface Run {
  case: TestCase;
  seed: string;
  mutation: string[];
  result: CaseResult;
  bypass: boolean;
  root?: RootCause;
}

export const isBypass = (c: TestCase, r: CaseResult) => c.category !== "legit" && c.expected.decision !== "ALLOW" && r.actual === "ALLOW";

// Why the action was the attacker's choice, read from the same texts the firewall reads.
export function rootCause(c: TestCase, bundle: RuleBundle): RootCause {
  const parsed = PaymentArgs.safeParse(c.action.args);
  if (parsed.success) {
    const analyses = analyzeContext(c.context, bundle, undefined, true);
    for (const [k, item] of c.context.entries()) {
      if (item.trust === "trusted") continue;
      for (const line of parsed.data.items) {
        const claims = findClaims(item.id, analyses[k]?.texts ?? [], line.sku, line.name);
        const claim = claims[0];
        if (claim) {
          return {
            template: "item_in_claim",
            item_id: item.id,
            sku: line.sku,
            remainder: claim.remainder,
            fingerprint: claim.fingerprint,
            excerpt: claim.excerpt,
          };
        }
      }
    }
  }
  return { template: "unexplained" };
}

export function runOne(c: TestCase, seed: string, mutation: string[], bundle: RuleBundle, merchants: MerchantRecord[], sensors?: SensorVectors): Run {
  const result = runCase(c, merchants, undefined, bundle, sensors);
  const bypass = isBypass(c, result);
  return { case: c, seed, mutation, result, bypass, ...(bypass && { root: rootCause(c, bundle) }) };
}

// Seeds and every variant. Seeds of one category recombine with each other.
export function expand(seeds: TestCase[], paraphrases: string[] = PARAPHRASES): Variant[] {
  const out: Variant[] = [];
  for (const s of seeds) {
    out.push({ case: s, seed: s.id, mutation: [] });
    out.push(...mutate(s, seeds.filter((o) => o.category === s.category), paraphrases));
  }
  return out;
}

export function runAll(variants: Variant[], bundle: RuleBundle, merchants: MerchantRecord[], sensors?: SensorVectors): Run[] {
  return variants.map((v) => runOne(v.case, v.seed, v.mutation, bundle, merchants, sensors));
}

// Level 1 of learning: the exact attack. The same page and action again is the same attack.
export const exactHash = (c: TestCase) => hashCanonical(["attack/v1", c.context, c.action]);
