import { describe, expect, it } from "vitest";
import { computeTotals, DELIVERY_FEE_CENTS } from "../src/lib/pricing";

describe("computeTotals", () => {
  it("is all zeros for an empty cart", () => {
    expect(computeTotals([])).toEqual({ itemCount: 0, subtotalCents: 0, deliveryCents: 0, totalCents: 0 });
  });

  it("charges delivery under $35", () => {
    const t = computeTotals([{ unitPriceCents: 450, quantity: 2 }]);
    expect(t.subtotalCents).toBe(900);
    expect(t.deliveryCents).toBe(DELIVERY_FEE_CENTS);
    expect(t.totalCents).toBe(900 + DELIVERY_FEE_CENTS);
  });

  it("makes delivery free at exactly $35", () => {
    const t = computeTotals([{ unitPriceCents: 3500, quantity: 1 }]);
    expect(t.deliveryCents).toBe(0);
    expect(t.totalCents).toBe(3500);
  });

  it("rejects negative or fractional values", () => {
    expect(() => computeTotals([{ unitPriceCents: -1, quantity: 1 }])).toThrow();
    expect(() => computeTotals([{ unitPriceCents: 100, quantity: 1.5 }])).toThrow();
  });
});
