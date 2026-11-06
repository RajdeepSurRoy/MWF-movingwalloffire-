import { z } from "zod";

// Money is a decimal string, never a float, so amounts hash and compare exactly.
export const Money = z.strictObject({
  value: z.string().regex(/^\d{1,9}(\.\d{1,2})?$/, "decimal string with up to 2 places"),
  currency: z.string().regex(/^[A-Z]{3}$/, "ISO 4217 code"),
});
export type Money = z.infer<typeof Money>;

export const DecisionValue = z.enum(["ALLOW", "BLOCK", "REVIEW"]);

// What the user actually asked for, as structured limits (architecture §3, checkpoint 1).
export const Mandate = z.strictObject({
  intent_text: z.string().min(1).max(2000),
  category: z.string().min(1).max(100),
  // Set when one order may span several categories, as a grocery basket does. Replaces `category`.
  categories: z.array(z.string().min(1).max(100)).min(1).max(50).optional(),
  // For the whole session, not per order: several purchases share it.
  max_total: Money,
  per_item_max: Money.optional(),
  // The most the merchant may add on top of the items (delivery and the like). Absent: no fees.
  max_fee: Money.optional(),
  merchants: z.array(z.string().min(1).max(200)).min(1).max(50),
  allowed_actions: z.array(z.string().min(1).max(100)).min(1).max(50),
  expires_at: z.iso.datetime(),
});
export type Mandate = z.infer<typeof Mandate>;

// Anything the agent read. Untrusted unless it came from the user or the business itself.
export const ContextItem = z.strictObject({
  id: z.string().min(1).max(200),
  source: z.strictObject({
    kind: z.enum(["web_page", "tool_result", "document", "email", "user"]),
    uri: z.string().max(2000).optional(),
  }),
  trust: z.enum(["trusted", "untrusted"]).default("untrusted"),
  content_type: z.enum(["text/html", "text/plain", "application/json"]),
  content: z.string().max(500_000),
  // Stylesheets the agent's browser loaded for this page (from <link rel="stylesheet"> and
  // @import), as it received them. The firewall never fetches them itself: no SSRF, and the
  // page's server cannot show the firewall different CSS than the agent got.
  resources: z
    .array(
      z.strictObject({
        url: z.url({ protocol: /^https?$/ }).max(2000),
        content_type: z.literal("text/css"),
        content: z.string().max(1_000_000),
        // The request for `url` was redirected here (content is then empty). Kept so a sheet's
        // relative @imports resolve against where it really came from, as in the agent's browser.
        redirect_to: z.url({ protocol: /^https?$/ }).max(2000).optional(),
      }),
    )
    .max(50)
    .refine((r) => r.reduce((n, x) => n + x.content.length, 0) <= 2_000_000, "resources exceed 2,000,000 characters in total")
    .optional(),
});
export type ContextItem = z.infer<typeof ContextItem>;

export const LineItem = z.strictObject({
  sku: z.string().min(1).max(100),
  name: z.string().min(1).max(500),
  category: z.string().min(1).max(100),
  unit_price: Money,
  quantity: z.number().int().min(1).max(1000),
});
export type LineItem = z.infer<typeof LineItem>;

export const Merchant = z.strictObject({
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(200),
  payee_email: z.email().optional(),
  // Where the agent's browser really was at checkout. Set by the integration from the page's
  // address, never by the model, and matched against the merchant registry.
  checkout_origin: z.url({ protocol: /^https?$/ }).max(2000).optional(),
});
export type Merchant = z.infer<typeof Merchant>;

// A charge on top of the items, such as delivery.
export const Fee = z.strictObject({ label: z.string().min(1).max(200), amount: Money });
export type Fee = z.infer<typeof Fee>;

// Arguments of payment.* actions. Other action types keep their args generic.
export const PaymentArgs = z.strictObject({
  merchant: Merchant,
  items: z.array(LineItem).min(1).max(100),
  fees: z.array(Fee).max(10).optional(),
  total: Money,
});
export type PaymentArgs = z.infer<typeof PaymentArgs>;

// A side effect the agent wants to cause. The core does not know what a payment is;
// the action type tells the policy which argument schema applies.
export const ProposedAction = z.strictObject({
  type: z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/, "dotted action type, e.g. payment.capture"),
  args: z.record(z.string(), z.unknown()),
  // Context item ids the agent says the action relied on. Used by the provenance graph (M4).
  derived_from: z.array(z.string().max(200)).max(200).default([]),
});
export type ProposedAction = z.infer<typeof ProposedAction>;

export const Reason = z.strictObject({
  rule_id: z.string(),
  message: z.string(),
  // What the reason is about: a context item id, a SKU or a merchant id.
  ref: z.string().optional(),
});
export type Reason = z.infer<typeof Reason>;

export const DecisionResult = z.strictObject({
  decision: DecisionValue,
  reasons: z.array(Reason),
});
export type DecisionResult = z.infer<typeof DecisionResult>;

export const Checkpoint = z.enum(["intent", "context", "action", "commit", "output"]);
export type Checkpoint = z.infer<typeof Checkpoint>;

// Everything needed to explain and replay a decision later.
export const DecisionRecord = z.strictObject({
  id: z.string(),
  tenant_id: z.string(),
  session_id: z.string().nullable(),
  checkpoint: Checkpoint,
  decision: DecisionValue,
  reasons: z.array(Reason),
  policy_version: z.string(),
  rule_bundle_version: z.string(),
  model_hashes: z.record(z.string(), z.string()),
  action_hash: z.string().nullable(),
  graph_path: z.array(z.string()),
  created_at: z.iso.datetime(),
});
export type DecisionRecord = z.infer<typeof DecisionRecord>;

// A ground-truth test case for the harness. `expected.at` says which checkpoint should catch it.
export const TestCase = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]+$/),
  category: z.enum([
    "legit",
    "direct_override",
    "persuasion",
    "hidden_text",
    "fake_compliance",
    "lookalike_merchant",
    "transaction_modification",
  ]),
  description: z.string(),
  now: z.iso.datetime(),
  mandate: Mandate,
  context: z.array(ContextItem),
  action: ProposedAction,
  // What actually reaches execution. Absent means the approved action is executed unchanged.
  commit_action: ProposedAction.optional(),
  // The same approved action is committed twice (duplicate / retry attack).
  replay_commit: z.boolean().default(false),
  expected: z.strictObject({
    decision: DecisionValue,
    at: z.enum(["action", "commit"]),
  }),
});
export type TestCase = z.infer<typeof TestCase>;
export type TestCategory = TestCase["category"];
