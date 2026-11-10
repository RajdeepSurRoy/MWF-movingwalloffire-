export const FREE_DELIVERY_THRESHOLD_CENTS = 3500;
export const DELIVERY_FEE_CENTS = 499;

export type PricedLine = { unitPriceCents: number; quantity: number };

export type Totals = {
  itemCount: number;
  subtotalCents: number;
  deliveryCents: number;
  totalCents: number;
};

/**
 * The only place totals are calculated. Callers pass prices read from the
 * database, never prices supplied by the browser or the assistant.
 */
export function computeTotals(lines: PricedLine[]): Totals {
  let subtotalCents = 0;
  let itemCount = 0;
  for (const line of lines) {
    if (!Number.isInteger(line.unitPriceCents) || line.unitPriceCents < 0) {
      throw new Error("Invalid unit price");
    }
    if (!Number.isInteger(line.quantity) || line.quantity <= 0) {
      throw new Error("Invalid quantity");
    }
    subtotalCents += line.unitPriceCents * line.quantity;
    itemCount += line.quantity;
  }
  const deliveryCents =
    itemCount === 0 || subtotalCents >= FREE_DELIVERY_THRESHOLD_CENTS ? 0 : DELIVERY_FEE_CENTS;
  return { itemCount, subtotalCents, deliveryCents, totalCents: subtotalCents + deliveryCents };
}

export function formatPrice(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}
