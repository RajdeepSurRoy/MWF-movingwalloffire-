import { canonicalize, hashCanonical } from "./canonical.js";
import { type MerchantRecord, lookalikeOf, normalizeEmail, originOf, sameId } from "./merchant.js";
import { formatCents, toCents } from "./money.js";
import { type RuleBundle, getDefaultBundle, regex } from "./rules.js";
import type { RenderReports } from "./rendered.js";
import { type Graph, actionGraph, actionId, contextGraph, taintPaths } from "./provenance.js";
import { type Finding, analyzeContext, scanText } from "./scan.js";
import { checkClaims } from "./claims.js";
import {
  type ContextItem,
  type DecisionResult,
  type Mandate,
  PaymentEffect,
  type PreparedEffect,
  type ProposedAction,
  type Reason,
  PaymentArgs,
} from "./schemas.js";

// Version of the decision logic itself (this file). The rule bundle has its own version.
// 1.1: provenance graph, cross-element matching. 1.2: encoded canaries.
// 1.3: several categories, fees, checkout origin, session spending; a repeated signal counts once.
// 1.4: commit checks what the outside system actually prepared (two-phase commit; payments first).
// 1.5: learned claim rules from the red team (REVIEW only; shadow rules recorded, not enforced).
//      Text the parser splits at entities is read as one text.
export const POLICY_VERSION = "1.5.0";

export interface EngineResult extends DecisionResult {
  // Context findings behind the decision, and how much they add to the session risk score.
  findings: Finding[];
  risk: number;
  // The provenance graph this checkpoint built, and the path behind the decision (node ids,
  // from the attack point to the action), when there is one.
  graph?: Graph;
  path?: string[];
  // What learned rules still in shadow would have added. Recorded for the backtest and the
  // console; never part of the decision.
  shadow?: Reason[];
}

const reason = (rule_id: string, message: string, ref?: string): Reason =>
  ref === undefined ? { rule_id, message } : { rule_id, message, ref };

// The table in architecture §7: any BLOCK reason wins, then any REVIEW reason, else ALLOW.
function combine(block: Reason[], review: Reason[], findings: Finding[], risk: number): EngineResult {
  if (block.length) return { decision: "BLOCK", reasons: [...block, ...review], findings, risk };
  if (review.length) return { decision: "REVIEW", reasons: review, findings, risk };
  return { decision: "ALLOW", reasons: [reason("ALLOW.ALL_CHECKS_PASSED", "Every required check passed")], findings, risk };
}

// Each distinct signal counts once. A site repeats its own markup on every page (a screen-reader
// label, a hidden menu), and counting it per page held ordinary shopping after a dozen pages.
const findingRisk = (findings: Finding[], bundle: RuleBundle) => {
  const seen = new Set<string>();
  let sum = 0;
  for (const f of findings) {
    // The fingerprint covers all the detected content; the excerpt is only its first few words.
    const key = `${f.rule_id}|${f.severity}|${f.channel}|${f.fingerprint ?? `item:${f.item_id}|${f.excerpt}`}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sum += bundle.risk.weights[f.severity];
  }
  return sum;
};

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

export function checkContext(
  items: ContextItem[],
  bundle = getDefaultBundle(),
  renders?: RenderReports,
): EngineResult & { quarantined: string[] } {
  const analyses = analyzeContext(items, bundle, renders);
  const findings = analyses.flatMap((a) => a.findings);
  const hard = findings.filter((f) => f.severity === "hard");
  const soft = findings.filter((f) => f.severity === "soft");
  const quarantined = [...new Set(hard.map((f) => f.item_id))];
  const result = combine(hard.map(findingReason), soft.map(findingReason), findings, findingRisk(findings, bundle));
  return { ...result, quarantined, graph: contextGraph(items, analyses) };
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
  // Cents this session has already spent or reserved. max_total covers all of it.
  spentCents?: number;
  // Risk carried over from earlier decisions in the session.
  priorRisk?: number;
  // Context item ids quarantined at checkpoint 2. Sticky: a later rule bundle cannot un-quarantine them.
  quarantined?: string[];
  // Headless-browser views of the context items, keyed by item hash. Missing: static scan only.
  renders?: RenderReports;
}

function checkPayment(input: ActionCheckInput, bundle: RuleBundle, block: Reason[], review: Reason[]) {
  const { mandate, merchants } = input;
  const parsed = PaymentArgs.safeParse(input.action.args);
  if (!parsed.success) {
    block.push(reason("POL.ARGS_INVALID", `payment arguments do not match the schema: ${parsed.error.issues[0]?.message ?? "invalid"}`));
    return;
  }
  const { merchant, items, fees = [], total } = parsed.data;
  const currency = mandate.max_total.currency;

  // Spending policy.
  const moneys = [total, ...items.map((i) => i.unit_price), ...fees.map((f) => f.amount), ...(mandate.max_fee ? [mandate.max_fee] : [])];
  if (moneys.some((m) => m.currency !== currency)) {
    block.push(reason("POL.CURRENCY_MISMATCH", `All amounts must be in ${currency}`));
    return;
  }
  const feeSum = fees.reduce((s, f) => s + toCents(f.amount), 0);
  const sum = items.reduce((s, i) => s + toCents(i.unit_price) * i.quantity, feeSum);
  if (sum !== toCents(total)) {
    block.push(reason("POL.TOTAL_MISMATCH", `Line items and fees add up to ${formatCents(sum, currency)}, total says ${formatCents(toCents(total), currency)}`));
  }
  // Without this cap, a "mandatory" add-on could ride along as a fee, outside every item rule.
  if (feeSum > (mandate.max_fee ? toCents(mandate.max_fee) : 0)) {
    block.push(reason("POL.FEE_OVER_CAP", `Fees of ${formatCents(feeSum, currency)} exceed what the mandate allows`));
  }
  const spent = input.spentCents ?? 0;
  if (toCents(total) > toCents(mandate.max_total)) {
    block.push(reason("POL.OVER_BUDGET", `Total ${formatCents(toCents(total), currency)} exceeds the mandate's ${formatCents(toCents(mandate.max_total), currency)}`));
  } else if (spent + toCents(total) > toCents(mandate.max_total)) {
    block.push(reason("POL.SESSION_BUDGET", `This session has already spent or reserved ${formatCents(spent, currency)} of ${formatCents(toCents(mandate.max_total), currency)}`));
  }
  const categories = mandate.categories ?? [mandate.category];
  for (const item of items) {
    if (!categories.includes(item.category)) {
      block.push(reason("POL.CATEGORY", `"${item.name}" is ${item.category}; the user asked for ${categories.join(", ")}`, item.sku));
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

  // Payee: money must go where the business's registry says this merchant is paid. A third-party
  // agent often cannot see a payee address, so the checkout's origin can verify it instead. Either
  // one that is present must match.
  const record = merchants.find((m) => sameId(m.id, merchant.id));
  if (!record) {
    review.push(reason("MER.PAYEE_UNVERIFIED", `No registry entry for "${merchant.id}"; payee cannot be verified`, merchant.id));
    return;
  }
  const origin = merchant.checkout_origin ? originOf(merchant.checkout_origin) : null;
  const originMatches = origin !== null && (record.checkout_origins ?? []).some((o) => originOf(o) === origin);
  if (merchant.checkout_origin && !originMatches) {
    block.push(reason("MER.ORIGIN_MISMATCH", `Checkout at ${merchant.checkout_origin} is not a registered checkout of "${merchant.id}"`, merchant.id));
  }
  if (merchant.payee_email) {
    if (!record.payee_emails.map(normalizeEmail).includes(normalizeEmail(merchant.payee_email))) {
      block.push(reason("MER.PAYEE_MISMATCH", `Payee ${merchant.payee_email} is not a registered payee of "${merchant.id}"`, merchant.id));
    }
  } else if (!merchant.checkout_origin) {
    review.push(reason("MER.PAYEE_UNVERIFIED", "The action names neither a payee nor a checkout origin", merchant.id));
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
    if (canary && leaksCanary(args, canary)) block.push(reason("SIG.CANARY_LEAK", "A session canary token appears in the action"));
  }

  // Context signals. Hard signatures in content the action relied on are a BLOCK; elsewhere in
  // the session a REVIEW, unless the provenance graph links them to a value in the action.
  const analyses = analyzeContext(input.context, bundle, input.renders);
  const findings = analyses.flatMap((a) => a.findings);
  const onPath = new Set(action.derived_from);
  for (const f of findings) {
    if (f.severity === "hard") (onPath.has(f.item_id) ? block : review).push(findingReason(f));
    else if (f.severity === "soft") review.push(findingReason(f));
  }

  for (const id of input.quarantined ?? []) {
    if (onPath.has(id)) block.push(reason("CTX.QUARANTINED_SOURCE", "The action relies on content quarantined at the context scan", id));
    else review.push(reason("CTX.QUARANTINED_IN_SESSION", "The session contains quarantined content", id));
  }

  // Provenance: an item, price or payee in the action that appears in flagged text. This holds
  // whatever the agent declares in derived_from, which a compromised agent can leave out.
  const graph = actionGraph({ mandate, items: input.context, analyses, action });
  const paths = taintPaths(graph, actionId(action));
  if (graph.truncated) {
    (graph.truncated === "hard" ? block : review).push(
      reason("PROV.GRAPH_TRUNCATED", `Too much ${graph.truncated}-flagged text in the session to check where the action's values came from`),
    );
  }
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  for (const p of paths) {
    if (p.via !== "value") continue;
    const span = nodes.get(p.nodes[0]!)?.attrs;
    const value = nodes.get(p.nodes[1]!)?.attrs;
    const what = `${String(value?.kind)} "${String(value?.label)}"`;
    const where = `${String(span?.channel)} text in ${String(span?.item_id)}: "${String(span?.text).slice(0, 80)}"`;
    (p.signal === "hard" ? block : review).push(reason("PROV.TAINTED_VALUE", `The action's ${what} comes from ${p.signal}-flagged ${where}`, String(span?.item_id)));
  }

  // Learned claim rules: the item bought is the one an untrusted page talked the agent into.
  const claims = checkClaims(input.context, analyses.map((a) => a.texts ?? []), action, bundle);
  review.push(...claims.enforced);

  const risk = findingRisk(findings, bundle);
  const total = (input.priorRisk ?? 0) + risk;
  if (block.length === 0 && review.length === 0 && total >= bundle.risk.review_threshold) {
    review.push(reason("RISK.SESSION_SCORE", `Session risk ${total} is at or above ${bundle.risk.review_threshold}`));
  }
  const result = combine(block, review, findings, risk);
  const path = result.decision === "ALLOW" ? undefined : paths[0]?.nodes;
  return { ...result, graph, ...(path && { path }), ...(claims.shadow.length > 0 && { shadow: claims.shadow }) };
}

// ---------------------------------------------------------------------------
// Checkpoint 4 — commit integrity: execute exactly what was approved, once.

export interface CommitCheckInput {
  approvedActionHash: string;
  executedAction: ProposedAction;
  alreadyCommitted: boolean;
  expired?: boolean;
  // What the outside system says it has prepared, and the tenant's merchant registry to check a
  // payment's payee against. The payee in the action came from the agent; this one from the system.
  prepared?: PreparedEffect;
  merchants?: MerchantRecord[];
}

export function checkCommit(input: CommitCheckInput): EngineResult {
  const block: Reason[] = [];
  if (input.alreadyCommitted) block.push(reason("COMMIT.REPLAY", "This action token was already used"));
  if (input.expired) block.push(reason("COMMIT.TOKEN_EXPIRED", "The action token has expired"));
  if (hashCanonical(input.executedAction) !== input.approvedActionHash) {
    block.push(reason("COMMIT.HASH_MISMATCH", "The action being executed differs from the one approved"));
  }
  const review: Reason[] = [];
  const ok = [reason("COMMIT.HASH_MATCH", "Executed action matches the approved hash")];
  if (input.prepared) checkPrepared(input.prepared, input.executedAction, input.merchants ?? [], { block, review, ok });
  if (block.length) return { decision: "BLOCK", reasons: block, findings: [], risk: 0 };
  if (review.length) return { decision: "REVIEW", reasons: review, findings: [], risk: 0 };
  return { decision: "ALLOW", reasons: ok, findings: [], risk: 0 };
}

interface Verdicts {
  block: Reason[];
  review: Reason[];
  ok: Reason[];
}

// One checker per action family compares what the outside system prepared with the approved
// action. A new family gets its checker here; until then its prepared effect is recorded only.
const EFFECT_CHECKERS: { prefix: string; check: (effect: Record<string, unknown>, action: ProposedAction, merchants: MerchantRecord[], v: Verdicts) => void }[] = [
  { prefix: "payment.", check: checkPaymentEffect },
];

function checkPrepared(prepared: PreparedEffect, action: ProposedAction, merchants: MerchantRecord[], v: Verdicts) {
  if (!prepared.ready) {
    v.block.push(reason("COMMIT.EFFECT_NOT_READY", `${prepared.system} does not hold this action ready (${prepared.status ?? "not ready"})`));
  }
  const checker = EFFECT_CHECKERS.find((c) => action.type.startsWith(c.prefix));
  if (checker) checker.check(prepared.effect, action, merchants, v);
  else v.ok.push(reason("COMMIT.EFFECT_RECORDED", `No check for ${action.type} effects yet; recorded only`));
}

// The provider must take exactly the approved total, and pay an address the registry lists for
// the approved merchant. A merchant registered by checkout address only has no payee to compare
// with, so a person decides.
function checkPaymentEffect(raw: Record<string, unknown>, action: ProposedAction, merchants: MerchantRecord[], v: Verdicts) {
  const effect = PaymentEffect.safeParse(raw);
  const payment = PaymentArgs.safeParse(action.args);
  if (!effect.success || !payment.success) {
    v.block.push(reason("COMMIT.EFFECT_INVALID", "The prepared payment does not say what amount and payee it holds"));
    return;
  }
  const { amount, payee } = effect.data;
  const total = payment.data.total;
  if (amount.currency !== total.currency || toCents(amount) !== toCents(total)) {
    v.block.push(reason("COMMIT.EFFECT_AMOUNT_MISMATCH", `The provider holds ${amount.value} ${amount.currency}, the approved total is ${total.value} ${total.currency}`));
  }
  const merchant = merchants.find((m) => sameId(m.id, payment.data.merchant.id));
  if (!merchant || merchant.payee_emails.length === 0) {
    v.review.push(reason("COMMIT.EFFECT_PAYEE_UNVERIFIED", "No registered payee to compare the provider's payee with"));
  } else if (!payee.email) {
    v.review.push(reason("COMMIT.EFFECT_PAYEE_UNVERIFIED", "The provider did not report the payee's email"));
  } else if (!merchant.payee_emails.some((p) => normalizeEmail(p) === normalizeEmail(payee.email!))) {
    v.block.push(reason("COMMIT.EFFECT_PAYEE_MISMATCH", "The provider would pay someone the registry does not list for this merchant"));
  } else {
    v.ok.push(reason("COMMIT.EFFECT_MATCH", "The provider holds the approved amount for a registered payee"));
  }
}

// ---------------------------------------------------------------------------
// Checkpoint 5 — output check: leaks and exfiltration.

// The canary as written, in any case, percent-encoded up to three times, or as whole-string hex
// or base64. Best effort: anything that re-encodes it differently still passes, which is why the
// SDK limits where an agent can send data at all.
export function leaksCanary(content: string, canary: string): boolean {
  let text = content;
  for (let i = 0; i < 3; i++) text = text.replace(/%([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  const bytes = new TextEncoder().encode(canary);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  const base64 = btoa(String.fromCharCode(...bytes)).replace(/=+$/, "");
  const lower = text.toLowerCase();
  return [canary.toLowerCase(), hex].some((f) => lower.includes(f)) || [base64, base64.replace(/\+/g, "-").replace(/\//g, "_")].some((f) => text.includes(f));
}

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
    if (canary && leaksCanary(content, canary)) block.push(reason("SIG.CANARY_LEAK", "A session canary token appears in the output"));
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
