import { hashCanonical } from "./canonical.js";
import type { RuleBundle } from "./rules.js";
import { type ContextItem, PaymentArgs, type ProposedAction, type Reason } from "./schemas.js";

// Learned claim rules (M8). The persuasion attack: an untrusted page praises one product ("9 out
// of 10 engineers choose X", "the safe pick") and the agent buys it. Every value is in budget
// and in category, so no policy rule fires. The red team learns these rules from attacks that
// got through (redteam/), and a person approves each one.
//
// A rule fires when an item in the action is named inside a claim: text on an untrusted page
// that names the item and says more than its name. The claim must also match one of the rule's
// phrases or the fingerprint of a known attack. Learned rules can only send an action to REVIEW,
// never BLOCK. Phrases are matched as plain word sequences, not regexes, so learned content
// cannot be a slow pattern. A rule carries phrases and fingerprints only: no page text and no
// item names, so a rule can be shared between tenants without sharing their data.

// Latin lookalikes from other scripts, folded so "сhoice" with a Cyrillic с matches "choice".
// NFKC already folds full-width and most compatibility forms.
const CONFUSABLES: Record<string, string> = {
  а: "a", в: "b", е: "e", ё: "e", к: "k", м: "m", н: "h", о: "o", р: "p", с: "c", т: "t", у: "y", х: "x", і: "i", ј: "j", ѕ: "s", ԁ: "d", ɡ: "g", һ: "h", ԛ: "q", ԝ: "w",
  α: "a", β: "b", ε: "e", η: "n", ι: "i", κ: "k", ν: "v", ο: "o", ρ: "p", τ: "t", υ: "u", χ: "x", ϲ: "c",
  ı: "i", ℓ: "l",
};
const ZERO_WIDTH = /[​-‍⁠﻿­]/g;

// Lowercased words, with digits replaced by "#" so "9 out of 10" and "8 out of 10" read the same.
export function claimTokens(text: string): string[] {
  let t = text.normalize("NFKC").replace(ZERO_WIDTH, "").toLowerCase();
  t = [...t].map((ch) => CONFUSABLES[ch] ?? ch).join("");
  return (t.match(/[\p{L}\p{N}]+/gu) ?? []).map((w) => (/\p{N}/u.test(w) && !/\p{L}/u.test(w) ? "#" : w));
}

const ITEM_STOP = new Set(["the", "and", "for", "with", "pack", "set", "pcs", "per", "from"]);

// The words that name an item: its SKU, or most of the words of its name.
function itemWords(sku: string, name: string): { words: Set<string>; need: number; sku: string[] } {
  const words = [...new Set(claimTokens(name).filter((w) => w.length >= 3 && w !== "#" && !ITEM_STOP.has(w)))];
  const need = words.length === 1 ? (words[0]!.length >= 5 ? 1 : Infinity) : Math.max(2, Math.ceil((2 * words.length) / 3));
  return { words: new Set(words), need, sku: sku.length >= 3 ? claimTokens(sku) : [] };
}

const containsSeq = (hay: string[], needle: string[]) => {
  if (needle.length === 0) return false;
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
};

// Fewest words a text must have beyond the item's name to be a claim rather than a listing.
export const CLAIM_MIN_EXTRA_WORDS = 3;

export interface Claim {
  item_id: string;
  sku: string;
  // The claim text without the item's own words: what the page says about it.
  remainder: string[];
  // The claim with the item's words replaced by "<item>": what the embedding sensor reads.
  skeleton: string[];
  // Hash of the claim with the item's words replaced by a placeholder. The same attack on
  // another product, or re-encoded, has the same fingerprint.
  fingerprint: string;
  excerpt: string;
}

// Claims about `sku`/`name` in an item's texts. Pass one text per block element (paragraph,
// list item), as ItemAnalysis.texts has them: a claim split by inline tags is then one text,
// and a claim in the next paragraph about another product is not this item's.
export function findClaims(itemId: string, texts: string[], sku: string, name: string): Claim[] {
  const target = itemWords(sku, name);
  const notItem = (w: string) => !target.words.has(w) && !target.sku.includes(w);
  // Words that say something: not the item's, not numbers, not filler. A listing ("UltraCell
  // Pro AA, 8 pack") has none; a claim has several.
  const saying = (toks: string[]) => toks.filter((w) => notItem(w) && w !== "#" && w.length >= 3 && !ITEM_STOP.has(w)).length;
  const claims: Claim[] = [];
  const seen = new Set<string>();
  for (const text of texts) {
    const own = claimTokens(text);
    const named = containsSeq(own, target.sku) || own.filter((w) => target.words.has(w)).length >= target.need;
    if (!named || saying(own) < CLAIM_MIN_EXTRA_WORDS) continue;
    const skeleton = own.map((w) => (notItem(w) ? w : "<item>")).filter((w, i, a) => w !== "<item>" || a[i - 1] !== "<item>");
    const fingerprint = hashCanonical(["claim/v1", skeleton]);
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    claims.push({ item_id: itemId, sku, remainder: own.filter(notItem), skeleton, fingerprint, excerpt: text.replace(/\s+/g, " ").trim().slice(0, 120) });
  }
  return claims;
}

export type ClaimRule = RuleBundle["claim_rules"][number];

// Which learned rule a claim matches, and why.
export function matchClaim(rule: ClaimRule, claim: Claim): string | null {
  if (rule.fingerprints.includes(claim.fingerprint)) return "matches a known attack";
  for (const phrase of rule.phrases) if (containsSeq(claim.remainder, phrase.split(" "))) return `says "${phrase}"`;
  return null;
}

export interface ClaimVerdicts {
  enforced: Reason[];
  // What rules still in shadow would have added. Recorded, never decides.
  shadow: Reason[];
}

// Runs the bundle's claim rules over an action's items. `texts[k]` are the texts of `items[k]`.
export function checkClaims(items: ContextItem[], texts: string[][], action: ProposedAction, bundle: RuleBundle): ClaimVerdicts {
  const out: ClaimVerdicts = { enforced: [], shadow: [] };
  if (bundle.claim_rules.length === 0 || !action.type.startsWith("payment.")) return out;
  const parsed = PaymentArgs.safeParse(action.args);
  if (!parsed.success) return out;
  const seen = new Set<string>();
  items.forEach((item, k) => {
    if (item.trust === "trusted") return;
    for (const line of parsed.data.items) {
      for (const claim of findClaims(item.id, texts[k] ?? [], line.sku, line.name)) {
        for (const rule of bundle.claim_rules) {
          const why = matchClaim(rule, claim);
          // One reason per rule, item and page, however many claims there are.
          const key = `${rule.id}|${line.sku}|${item.id}`;
          if (!why || seen.has(key)) continue;
          seen.add(key);
          const r: Reason = { rule_id: rule.id, message: `"${line.name}" is promoted by a claim that ${why} (learned rule): "${claim.excerpt}"`, ref: item.id };
          (rule.state === "enforced" ? out.enforced : out.shadow).push(r);
        }
      }
    }
  });
  return out;
}
