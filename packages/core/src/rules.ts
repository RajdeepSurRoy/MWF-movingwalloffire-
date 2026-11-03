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
