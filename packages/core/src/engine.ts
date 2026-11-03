import { canonicalize, hashCanonical } from "./canonical.js";
import { type MerchantRecord, lookalikeOf, normalizeEmail, sameId } from "./merchant.js";
import { formatCents, toCents } from "./money.js";
import { type RuleBundle, getDefaultBundle, regex } from "./rules.js";
import { type Finding, scanContext, scanText } from "./scan.js";
import {
  type ContextItem,
  type DecisionResult,
  type Mandate,
  type ProposedAction,
  type Reason,
  PaymentArgs,
} from "./schemas.js";

// Version of the decision logic itself (this file). The rule bundle has its own version.
export const POLICY_VERSION = "1.0.0";

export interface EngineResult extends DecisionResult {
  // Context findings behind the decision, and how much they add to the session risk score.
  findings: Finding[];
  risk: number;
}

const reason = (rule_id: string, message: string, ref?: string): Reason =>
  ref === undefined ? { rule_id, message } : { rule_id, message, ref };

// The table in architecture §7: any BLOCK reason wins, then any REVIEW reason, else ALLOW.
function combine(block: Reason[], review: Reason[], findings: Finding[], risk: number): EngineResult {
  if (block.length) return { decision: "BLOCK", reasons: [...block, ...review], findings, risk };
  if (review.length) return { decision: "REVIEW", reasons: review, findings, risk };
  return { decision: "ALLOW", reasons: [reason("ALLOW.ALL_CHECKS_PASSED", "Every required check passed")], findings, risk };
}

const findingRisk = (findings: Finding[], bundle: RuleBundle) =>
  findings.reduce((sum, f) => sum + bundle.risk.weights[f.severity], 0);

const findingReason = (f: Finding) =>
  reason(f.rule_id, `${f.severity} signal in ${f.channel} content: "${f.excerpt}"`, f.item_id);

// ---------------------------------------------------------------------------
// Checkpoint 1 — intent intake. The user can be the attacker too.

export function checkIntent(
  { prompt, mandate, now }: { prompt: string; mandate: Mandate; now: Date },
  bundle = getDefaultBundle(),
): EngineResult {
  const block: Reason[] = [];
  const review: Reason[] = [];
  const expires = Date.parse(mandate.expires_at);
  if (expires <= now.getTime()) block.push(reason("POL.MANDATE_EXPIRED", `Mandate expired at ${mandate.expires_at}`));
  if (expires - now.getTime() > bundle.mandate_max_ttl_days * 86_400_000) {
    review.push(reason("POL.MANDATE_TTL_TOO_LONG", `Mandates may last at most ${bundle.mandate_max_ttl_days} days`));
  }
  const findings = scanText(prompt, "prompt", bundle).filter((f) => f.severity === "hard" || f.severity === "soft");
  for (const f of findings) review.push(findingReason(f));
  return combine(block, review, findings, findingRisk(findings, bundle));
}

// ---------------------------------------------------------------------------
// Checkpoint 2 — context scan. Hard findings quarantine the item.

export function checkContext(items: ContextItem[], bundle = getDefaultBundle()): EngineResult & { quarantined: string[] } {
  const findings = scanContext(items, bundle);
  const hard = findings.filter((f) => f.severity === "hard");
  const soft = findings.filter((f) => f.severity === "soft");
  const quarantined = [...new Set(hard.map((f) => f.item_id))];
  return { ...combine(hard.map(findingReason), soft.map(findingReason), findings, findingRisk(findings, bundle)), quarantined };
}

// ---------------------------------------------------------------------------
// Checkpoint 3 — action check. The only place ALLOW is decided.

export interface ActionCheckInput {
  mandate: Mandate;
  context: ContextItem[];
  action: ProposedAction;
  now: Date;
  // The business's own merchant registry: which payees each merchant id may pay.
  merchants: MerchantRecord[];
  // Canary tokens planted in this session's agent prompt. Seeing one in an action means a leak.
  canaries?: string[];
  // Risk carried over from earlier decisions in the session.
  priorRisk?: number;
  // Context item ids quarantined at checkpoint 2. Sticky: a later rule bundle cannot un-quarantine them.
  quarantined?: string[];
}

function checkPayment(input: ActionCheckInput, bundle: RuleBundle, block: Reason[], review: Reason[]) {
  const { mandate, merchants } = input;
  const parsed = PaymentArgs.safeParse(input.action.args);
  if (!parsed.success) {
    block.push(reason("POL.ARGS_INVALID", `payment arguments do not match the schema: ${parsed.error.issues[0]?.message ?? "invalid"}`));
    return;
  }
  const { merchant, items, total } = parsed.data;
  const currency = mandate.max_total.currency;

  // Spending policy.
  const moneys = [total, ...items.map((i) => i.unit_price)];
  if (moneys.some((m) => m.currency !== currency)) {
    block.push(reason("POL.CURRENCY_MISMATCH", `All amounts must be in ${currency}`));
    return;
  }
  const sum = items.reduce((s, i) => s + toCents(i.unit_price) * i.quantity, 0);
  if (sum !== toCents(total)) {
    block.push(reason("POL.TOTAL_MISMATCH", `Line items add up to ${formatCents(sum, currency)}, total says ${formatCents(toCents(total), currency)}`));
  }
  if (toCents(total) > toCents(mandate.max_total)) {
    block.push(reason("POL.OVER_BUDGET", `Total ${formatCents(toCents(total), currency)} exceeds the mandate's ${formatCents(toCents(mandate.max_total), currency)}`));
  }
  for (const item of items) {
    if (item.category !== mandate.category) {
      block.push(reason("POL.CATEGORY", `"${item.name}" is ${item.category}; the user asked for ${mandate.category}`, item.sku));
    }
    if (mandate.per_item_max && toCents(item.unit_price) > toCents(mandate.per_item_max)) {
      block.push(reason("POL.ITEM_OVER_CAP", `"${item.name}" costs more than the per-item cap`, item.sku));
    }
  }

  // Merchant allowlist: exact match. Lookalike detection only explains the BLOCK.
  if (!mandate.merchants.some((m) => sameId(m, merchant.id))) {
    const imitated = lookalikeOf(merchant.id, mandate.merchants, bundle.merchant.lookalike_max_edit_distance);
    block.push(
      imitated
        ? reason("MER.LOOKALIKE", `Merchant "${merchant.id}" imitates allowlisted "${imitated}"`, merchant.id)
        : reason("MER.NOT_ALLOWLISTED", `Merchant "${merchant.id}" is not in the mandate`, merchant.id),
    );
    return;
  }

  // Payee: money must go where the business's registry says this merchant is paid.
  const record = merchants.find((m) => sameId(m.id, merchant.id));
  if (!record) {
    review.push(reason("MER.PAYEE_UNVERIFIED", `No registry entry for "${merchant.id}"; payee cannot be verified`, merchant.id));
  } else if (!merchant.payee_email) {
    review.push(reason("MER.PAYEE_UNVERIFIED", "The action does not name a payee", merchant.id));
  } else if (!record.payee_emails.map(normalizeEmail).includes(normalizeEmail(merchant.payee_email))) {
    block.push(reason("MER.PAYEE_MISMATCH", `Payee ${merchant.payee_email} is not a registered payee of "${merchant.id}"`, merchant.id));
  }
}

export function checkAction(input: ActionCheckInput, bundle = getDefaultBundle()): EngineResult {
  const block: Reason[] = [];
  const review: Reason[] = [];
  const { mandate, action, now } = input;

  // User authorization.
  if (!mandate.allowed_actions.includes(action.type)) {
    block.push(reason("POL.ACTION_NOT_ALLOWED", `The mandate does not allow ${action.type}`));
  }
  if (Date.parse(mandate.expires_at) <= now.getTime()) {
    block.push(reason("POL.MANDATE_EXPIRED", `Mandate expired at ${mandate.expires_at}`));
  }
  if (action.type.startsWith("payment.")) checkPayment(input, bundle, block, review);
  else review.push(reason("POL.UNKNOWN_ACTION_TYPE", `No policy for ${action.type} yet`));

  // Canary leak: the agent's hidden prompt reached an action argument.
  const args = canonicalize(action.args);
  for (const canary of input.canaries ?? []) {
    if (canary && args.includes(canary)) block.push(reason("SIG.CANARY_LEAK", "A session canary token appears in the action"));
  }

  // Context signals. Hard signatures in content the action relied on are a BLOCK;
  // elsewhere in the session they are a REVIEW until the provenance graph (M4) can prove a path.
  const findings = scanContext(input.context, bundle);
  const onPath = new Set(action.derived_from);
  for (const f of findings) {
    if (f.severity === "hard") (onPath.has(f.item_id) ? block : review).push(findingReason(f));
    else if (f.severity === "soft") review.push(findingReason(f));
  }

  for (const id of input.quarantined ?? []) {
    if (onPath.has(id)) block.push(reason("CTX.QUARANTINED_SOURCE", "The action relies on content quarantined at the context scan", id));
    else review.push(reason("CTX.QUARANTINED_IN_SESSION", "The session contains quarantined content", id));
  }

  const risk = findingRisk(findings, bundle);
  const total = (input.priorRisk ?? 0) + risk;
  if (block.length === 0 && review.length === 0 && total >= bundle.risk.review_threshold) {
    review.push(reason("RISK.SESSION_SCORE", `Session risk ${total} is at or above ${bundle.risk.review_threshold}`));
  }
  return combine(block, review, findings, risk);
}

// ---------------------------------------------------------------------------
// Checkpoint 4 — commit integrity: execute exactly what was approved, once.

export interface CommitCheckInput {
  approvedActionHash: string;
  executedAction: ProposedAction;
  alreadyCommitted: boolean;
  expired?: boolean;
}

export function checkCommit(input: CommitCheckInput): EngineResult {
  const block: Reason[] = [];
  if (input.alreadyCommitted) block.push(reason("COMMIT.REPLAY", "This action token was already used"));
  if (input.expired) block.push(reason("COMMIT.TOKEN_EXPIRED", "The action token has expired"));
  if (hashCanonical(input.executedAction) !== input.approvedActionHash) {
    block.push(reason("COMMIT.HASH_MISMATCH", "The action being executed differs from the one approved"));
  }
  if (block.length) return { decision: "BLOCK", reasons: block, findings: [], risk: 0 };
  return { decision: "ALLOW", reasons: [reason("COMMIT.HASH_MATCH", "Executed action matches the approved hash")], findings: [], risk: 0 };
}

// ---------------------------------------------------------------------------
// Checkpoint 5 — output check: leaks and exfiltration.

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    sum += d;
  }
  return sum % 10 === 0;
}

export function checkOutput({ content, canaries = [] }: { content: string; canaries?: string[] }, bundle = getDefaultBundle()): EngineResult {
  const block: Reason[] = [];
  const review: Reason[] = [];
  for (const canary of canaries) {
    if (canary && content.includes(canary)) block.push(reason("SIG.CANARY_LEAK", "A session canary token appears in the output"));
  }
  for (const rule of bundle.output_rules) {
    if (regex(bundle, rule.pattern, "u").test(content)) {
      (rule.decision === "BLOCK" ? block : review).push(reason(rule.id, "Output matches a leak pattern"));
    }
  }
  for (const m of content.matchAll(/\b(?:\d[ -]?){13,19}\b/g)) {
    const digits = m[0].replace(/\D/g, "");
    if (digits.length >= 13 && luhn(digits)) {
      review.push(reason("OUT.CARD_NUMBER", "Output contains what looks like a card number"));
      break;
    }
  }
  return combine(block, review, [], 0);
}
