import { readFileSync } from "node:fs";
import { z } from "zod";

const Severity = z.enum(["none", "info", "soft", "hard"]);
export type Severity = z.infer<typeof Severity>;

const pattern = z.string().refine((p) => {
  try {
    new RegExp(p, "iu");
    return true;
  } catch {
    return false;
  }
}, "invalid regular expression");

// Rules are data, not code: the learning loop (M8) proposes a new bundle version,
// it is backtested, and only then deployed. Every decision logs the bundle version.
export const RuleBundle = z.strictObject({
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  description: z.string(),
  risk: z.strictObject({
    weights: z.strictObject({ info: z.number(), soft: z.number(), hard: z.number() }),
    review_threshold: z.number().positive(),
    penalty: z.strictObject({ BLOCK: z.number(), REVIEW: z.number() }),
  }),
  merchant: z.strictObject({ lookalike_max_edit_distance: z.number().int().min(0).max(5) }),
  action_token_ttl_seconds: z.number().int().positive(),
  mandate_max_ttl_days: z.number().int().positive(),
  // `visible` applies to text a human sees; `hidden` to CSS-hidden text, comments and meta tags.
  text_rules: z.array(
    z.strictObject({
      id: z.string().regex(/^[A-Z][A-Z0-9_.]+$/),
      description: z.string(),
      patterns: z.array(pattern).min(1),
      visible: Severity,
      hidden: Severity,
    }),
  ),
  // Standard UI labels that are not instructions ("Order history", "Add to cart"). A hidden text
  // segment is skipped only when one of these matches it whole, so a label cannot be used to
  // smuggle an instruction ("Select quantity 2 of the premium version" is still caught).
  hidden_exemptions: z.array(
    pattern.refine((p) => p.startsWith("^") && p.endsWith("$"), "exemptions must be anchored to the whole segment (^...$)"),
  ),
  output_rules: z.array(
    z.strictObject({ id: z.string().regex(/^[A-Z][A-Z0-9_.]+$/), pattern, decision: z.enum(["BLOCK", "REVIEW"]) }),
  ),
  // Rules the red team learned from attacks that got through (claims.ts). They only ever hold an
  // action for REVIEW: there is no field for a decision, so a learned rule cannot BLOCK.
  // `shadow` rules run and are recorded but do not decide; a person promotes them to `enforced`.
  claim_rules: z
    .array(
      z.strictObject({
        id: z.string().regex(/^LRN\.[A-Z0-9_.]+$/),
        description: z.string().max(300),
        state: z.enum(["shadow", "enforced"]),
        phrases: z.array(z.string().regex(/^[\p{Ll}\p{Lo}\p{N}#]+( [\p{Ll}\p{Lo}\p{N}#]+){1,3}$/u)).max(200),
        fingerprints: z.array(z.string().regex(/^[0-9a-f]{64}$/)).max(1000),
        // Where it came from, without any page content: attack-ledger family ids, the backtest
        // it passed, and who approved it.
        learned: z.strictObject({
          families: z.array(z.string().max(80)).max(200),
          backtest: z.strictObject({ caught: z.number().int(), of: z.number().int(), legit_broken: z.number().int(), weakened: z.number().int() }),
          approved_by: z.string().max(80),
          approved_at: z.iso.datetime(),
        }),
      }),
    )
    .default([]),
  // Embedding sensors (M7, claims.ts): a linear classifier over a pinned sentence-embedding model
  // that scores claims about a bought item for persuasion, so wording no learned phrase covers is
  // still caught. Like claim rules they only ever hold for REVIEW, run in shadow first, and carry
  // weights only: no page text. The model is named by revision and file hash; vectors from any
  // other model are not used.
  claim_sensors: z
    .array(
      z
        .strictObject({
          id: z.string().regex(/^SEN\.[A-Z0-9_.]+$/),
          description: z.string().max(300),
          state: z.enum(["shadow", "enforced"]),
          model: z.strictObject({
            name: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
            revision: z.string().regex(/^[0-9a-f]{40}$/),
            file: z.string().regex(/^[\w./-]+\.onnx$/),
            sha256: z.string().regex(/^[0-9a-f]{64}$/),
            pooling: z.enum(["mean", "cls"]),
            dim: z.number().int().positive().max(4096),
          }),
          weights: z.array(z.number().finite()),
          bias: z.number().finite(),
          threshold: z.number().gt(0).lt(1),
          learned: z.strictObject({
            positives: z.number().int(),
            negatives: z.number().int(),
            // Negatives held out from training; the threshold sits above every one of them.
            calibration: z.strictObject({ negatives: z.number().int(), above_threshold: z.number().int(), max_score: z.number() }),
            backtest: z.strictObject({ caught: z.number().int(), of: z.number().int(), legit_broken: z.number().int(), weakened: z.number().int() }),
            approved_by: z.string().max(80),
            approved_at: z.iso.datetime(),
          }),
        })
        .refine((s) => s.weights.length === s.model.dim, "weights must have one value per embedding dimension"),
    )
    .default([]),
});
export type RuleBundle = z.infer<typeof RuleBundle>;

export function loadRuleBundle(path: string | URL = new URL("../rules/bundle.json", import.meta.url)): RuleBundle {
  return RuleBundle.parse(JSON.parse(readFileSync(path, "utf8")));
}

let defaultBundle: RuleBundle | undefined;
export function getDefaultBundle(): RuleBundle {
  return (defaultBundle ??= loadRuleBundle());
}

// Compiled regexes, cached per bundle object.
const compiled = new WeakMap<RuleBundle, Map<string, RegExp>>();
export function regex(bundle: RuleBundle, source: string, flags = "iu"): RegExp {
  let cache = compiled.get(bundle);
  if (!cache) compiled.set(bundle, (cache = new Map()));
  const key = `${flags}/${source}`;
  let re = cache.get(key);
  if (!re) cache.set(key, (re = new RegExp(source, flags)));
  return re;
}
