import { describe, expect, it } from "vitest";
import { canonicalize, hashCanonical } from "./canonical.js";

describe("canonicalize", () => {
  it("gives the same hash for the same action in a different key order", () => {
    const a = {
      type: "payment.authorize",
      args: { merchant: { id: "shop-a", name: "Shop A" }, total: { value: "12.50", currency: "USD" } },
    };
    const b = {
      args: { total: { currency: "USD", value: "12.50" }, merchant: { name: "Shop A", id: "shop-a" } },
      type: "payment.authorize",
    };
    expect(canonicalize(a)).toBe(canonicalize(b));
    expect(hashCanonical(a)).toBe(hashCanonical(b));
  });

  it("changes the hash when any value changes", () => {
    const base = { total: { value: "12.50", currency: "USD" } };
    expect(hashCanonical(base)).not.toBe(hashCanonical({ total: { value: "12.51", currency: "USD" } }));
  });

  it("keeps array order significant", () => {
    expect(canonicalize([1, 2])).not.toBe(canonicalize([2, 1]));
  });

  it("drops undefined properties and has no whitespace", () => {
    expect(canonicalize({ b: 1, a: undefined, c: [true, null, "x"] })).toBe('{"b":1,"c":[true,null,"x"]}');
  });

  it("rejects values that have no exact JSON form", () => {
    expect(() => canonicalize({ x: Number.NaN })).toThrow();
    expect(() => canonicalize({ x: Infinity })).toThrow();
    expect(() => canonicalize({ d: new Date(0) })).toThrow();
    expect(() => canonicalize({ n: 1n })).toThrow();
  });
});
