import { POLICY_VERSION, type RuleBundle, type TestCase, analyzeContext, claimTokens, hashCanonical } from "@mwf/core";
import { type RootCause, type Run, exactHash } from "./runner.js";

// The attack ledger and the four levels of learning.
//   1 exact        the same page and action again                    (exact hash)
//   2 fingerprint  the same claim, re-encoded or about another item  (claim fingerprint)
//   3 family       a near copy of a known claim                      (word-trigram similarity)
//   4 rule         a candidate claim rule: phrases + fingerprints     (from the root-cause template)
//
// Level 3 uses word trigrams until the M7 embedding sidecar exists; the family test is the one
// place that would change. Nothing here becomes a rule by itself: level 4 writes a candidate
// that a backtest checks and a person approves (rollout.ts).

export interface LedgerEntry {
  id: string;
  exact: string;
  fingerprint?: string;
  family: string;
  case_id: string;
  seed: string;
  mutation: string[];
  category: TestCase["category"];
  expected: string;
  actual: string;
  rule_ids: string[];
  bundle_version: string;
  policy_version: string;
  found_at: string;
  root: RootCause;
}

export interface Ledger {
  version: 1;
  entries: LedgerEntry[];
}

export const emptyLedger = (): Ledger => ({ version: 1, entries: [] });

// ---------------------------------------------------------------------------
// Level 3: families of near-identical claims.

const trigrams = (words: string[]) => {
  const out = new Map<string, number>();
  const padded = ["^", ...words, "$"];
  for (let i = 0; i + 2 < padded.length; i++) {
    const g = padded.slice(i, i + 3).join(" ");
    out.set(g, (out.get(g) ?? 0) + 1);
  }
  for (const w of words) out.set(w, (out.get(w) ?? 0) + 1);
  return out;
};

export function similarity(a: string[], b: string[]): number {
  const x = trigrams(a);
  const y = trigrams(b);
  let dot = 0;
  for (const [g, n] of x) dot += n * (y.get(g) ?? 0);
  const norm = (m: Map<string, number>) => Math.sqrt([...m.values()].reduce((s, n) => s + n * n, 0));
  return dot === 0 ? 0 : dot / (norm(x) * norm(y));
}

export const FAMILY_THRESHOLD = 0.6;

function familyOf(ledger: Ledger, root: RootCause, exact: string): string {
  if (root.fingerprint) {
    const same = ledger.entries.find((e) => e.fingerprint === root.fingerprint);
    if (same) return same.family;
  }
  if (root.remainder) {
    let best: { family: string; score: number } | null = null;
    for (const e of ledger.entries) {
      if (!e.root.remainder) continue;
      const score = similarity(root.remainder, e.root.remainder);
      if (score >= FAMILY_THRESHOLD && (!best || score > best.score)) best = { family: e.family, score };
    }
    if (best) return best.family;
  }
  return `fam-${(root.fingerprint ?? exact).slice(0, 12)}`;
}

// Records the bypasses of a run. An attack already in the ledger (level 1) is not added again.
export function record(ledger: Ledger, runs: Run[], bundle: RuleBundle, now = new Date()): LedgerEntry[] {
  const added: LedgerEntry[] = [];
  for (const r of runs) {
    if (!r.bypass || !r.root) continue;
    const exact = exactHash(r.case);
    if (ledger.entries.some((e) => e.exact === exact)) continue;
    const entry: LedgerEntry = {
      id: `atk-${exact.slice(0, 16)}`,
      exact,
      ...(r.root.fingerprint && { fingerprint: r.root.fingerprint }),
      family: familyOf(ledger, r.root, exact),
      case_id: r.case.id,
      seed: r.seed,
      mutation: r.mutation,
      category: r.case.category,
      expected: r.case.expected.decision,
      actual: r.result.actual,
      rule_ids: r.result.reasons.map((x) => x.rule_id),
      bundle_version: bundle.version,
      policy_version: POLICY_VERSION,
      found_at: now.toISOString(),
      root: r.root,
    };
    ledger.entries.push(entry);
    added.push(entry);
  }
  return added;
}

// ---------------------------------------------------------------------------
// Level 4: a candidate claim rule.

// Words too common to make a phrase on their own.
const STOP = new Set(
  "a an the and or but of to in on at by for with from as is are was be been being it its this that these those you your our we they their he she him her his them us me my i who what why how when where which all any each every some more most other than then so not no do does did don t s can could will would should may might must has have had up out over into about just also only very too here there one two".split(" "),
);
// A phrase must carry a word that says something: four letters or more, not filler.
const contentWord = (w: string) => w.length >= 4 && !STOP.has(w) && /^\p{L}+$/u.test(w);

const ngrams = (words: string[], n: number) => {
  const out: string[] = [];
  for (let i = 0; i + n <= words.length; i++) out.push(words.slice(i, i + n).join(" "));
  return out;
};

// Word pairs and triples that occur in ordinary shop pages: the legitimate cases' pages and a
// background of ordinary shop copy (`benign`, one text per line). A phrase a normal page uses
// would hold normal purchases.
export function legitPhrases(legit: TestCase[], bundle: RuleBundle, benign: string[] = []): Set<string> {
  const out = new Set<string>();
  for (const line of benign) {
    const words = claimTokens(line);
    for (const n of [2, 3]) for (const g of ngrams(words, n)) out.add(g);
  }
  for (const c of legit) {
    const analyses = analyzeContext(c.context, bundle, undefined, true);
    for (const a of analyses) {
      for (const text of a.texts ?? []) {
        const words = claimTokens(text);
        for (const n of [2, 3]) for (const g of ngrams(words, n)) out.add(g);
      }
    }
  }
  return out;
}

export interface Candidate {
  id: string;
  description: string;
  families: string[];
  phrases: string[];
  fingerprints: string[];
  entries: string[];
}

export const PHRASES_PER_FAMILY = 3;

// One candidate rule from the ledger's explained bypasses: per family, the few word pairs and
// triples its claims share that no legitimate page uses, and the fingerprints of its claims.
export function propose(entries: LedgerEntry[], legit: Set<string>): Candidate | null {
  const claims = entries.filter((e) => e.root.template === "item_in_claim" && e.root.remainder);
  if (claims.length === 0) return null;
  const byFamily = new Map<string, LedgerEntry[]>();
  for (const e of claims) byFamily.set(e.family, [...(byFamily.get(e.family) ?? []), e]);

  const phrases = new Set<string>();
  for (const members of byFamily.values()) {
    const support = new Map<string, number>();
    for (const m of members) {
      const grams = new Set([...ngrams(m.root.remainder!, 2), ...ngrams(m.root.remainder!, 3)]);
      for (const g of grams) {
        const words = g.split(" ");
        // Not on ordinary pages, no numbers, no filler at either end, and at least one word that
        // says something.
        if (legit.has(g) || words.includes("#") || words.some((w) => !/^[\p{Ll}\p{Lo}\p{N}]+$/u.test(w))) continue;
        if (STOP.has(words[0]!) || STOP.has(words[words.length - 1]!) || !words.some(contentWord)) continue;
        support.set(g, (support.get(g) ?? 0) + 1);
      }
    }
    // Most shared first; then the most words that say something; pairs before triples (they
    // generalize further); then alphabetical.
    const says = (g: string) => g.split(" ").filter(contentWord).length;
    const ranked = [...support.entries()].sort(
      ([a, x], [b, y]) => y - x || says(b) - says(a) || a.split(" ").length - b.split(" ").length || (a < b ? -1 : a > b ? 1 : 0),
    );
    for (const [g] of ranked.slice(0, PHRASES_PER_FAMILY)) phrases.add(g);
  }
  const fingerprints = [...new Set(claims.map((e) => e.fingerprint).filter((f): f is string => !!f))].sort();
  const families = [...byFamily.keys()].sort();
  const sortedPhrases = [...phrases].sort();
  return {
    id: `LRN.CLAIM.${hashCanonical([sortedPhrases, fingerprints]).slice(0, 8).toUpperCase()}`,
    description: `Item bought is named in a promotional claim on an untrusted page (learned from ${families.length} attack families)`,
    families,
    phrases: sortedPhrases,
    fingerprints,
    entries: claims.map((e) => e.id),
  };
}
