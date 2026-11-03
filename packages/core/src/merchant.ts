// Merchant and payee matching. Exact match decides; lookalike detection only explains a BLOCK.

export interface MerchantRecord {
  id: string;
  name: string;
  payee_emails: string[];
}

// Characters attackers swap in for ASCII lookalikes (Cyrillic, Greek, digits, dashes).
const CONFUSABLES: Record<string, string> = {
  "а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "у": "y", "х": "x",
  "ѕ": "s", "і": "i", "ј": "j", "һ": "h", "ԁ": "d", "ο": "o", "α": "a",
  "ε": "e", "ι": "i", "κ": "k", "ν": "v", "ρ": "p", "τ": "t",
  "0": "o", "1": "l", "3": "e", "5": "s", "|": "l",
  "‐": "-", "‑": "-", "‒": "-", "–": "-", "—": "-", "−": "-", "_": "-", ".": "-",
};

// A coarse "what it looks like" form, used only to name a lookalike.
export function skeleton(s: string): string {
  return [...s.normalize("NFKC").toLowerCase()].map((c) => CONFUSABLES[c] ?? c).join("").replace(/-+/g, "-");
}

export function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length]!;
}

// Ids are compared exactly after Unicode NFC only, so "shop-а" (Cyrillic) never equals "shop-a".
export const sameId = (a: string, b: string) => a.normalize("NFC").trim() === b.normalize("NFC").trim();

// The allowlisted id that `id` imitates, if any.
export function lookalikeOf(id: string, allowlist: string[], maxDistance: number): string | undefined {
  const sk = skeleton(id);
  return allowlist.find((allowed) => {
    if (sameId(id, allowed)) return false;
    const ask = skeleton(allowed);
    return (
      sk === ask ||
      sk.replace(/-/g, "") === ask.replace(/-/g, "") ||
      sk.startsWith(`${ask}-`) ||
      editDistance(sk, ask) <= maxDistance
    );
  });
}

export const normalizeEmail = (e: string) => e.normalize("NFC").trim().toLowerCase();
