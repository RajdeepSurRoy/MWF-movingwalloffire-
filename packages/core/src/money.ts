import type { Money } from "./schemas.js";

// Integer cents, so totals and limits compare exactly. Values are validated decimal strings.
export function toCents(m: Money): number {
  const [whole, frac = ""] = m.value.split(".");
  return Number(whole) * 100 + Number(frac.padEnd(2, "0"));
}

export const formatCents = (cents: number, currency: string) => `${(cents / 100).toFixed(2)} ${currency}`;
