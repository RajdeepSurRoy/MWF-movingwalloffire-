import { describe, expect, it } from "vitest";
import { checkAction } from "./engine.js";
import { RuleBundle, getDefaultBundle } from "./rules.js";
import { type SensorVectors, sensorTexts } from "./sensors.js";
import type { ContextItem, Mandate, ProposedAction } from "./schemas.js";

const NOW = new Date("2026-11-10T12:00:00Z");
const mandate: Mandate = {
  intent_text: "AA batteries under $25",
  category: "batteries",
  max_total: { value: "25.00", currency: "USD" },
  merchants: ["shop-a"],
  allowed_actions: ["payment.authorize"],
  expires_at: "2026-11-30T00:00:00Z",
};
const merchants = [{ id: "shop-a", name: "Shop A", payee_emails: ["payments@shop-a.example"] }];
const pro = { sku: "aa-pro-8", name: "UltraCell Pro AA, 8 pack", category: "batteries", unit_price: { value: "19.49", currency: "USD" }, quantity: 1 };
const action: ProposedAction = {
  type: "payment.authorize",
  args: { merchant: { id: "shop-a", name: "Shop A", payee_email: "payments@shop-a.example" }, items: [pro], total: { value: "19.49", currency: "USD" } },
  derived_from: ["page-1"],
};
const page = (body: string, trust: ContextItem["trust"] = "untrusted"): ContextItem => ({
  id: "page-1",
  source: { kind: "web_page" },
  trust,
  content_type: "text/html",
  content: `<html><body>${body}<ul><li><h3>UltraCell Pro AA, 8 pack</h3><p>$19.49</p></li></ul></body></html>`,
});
const CLAIM = "<p>Shoppers in the know always reach for UltraCell Pro AA, 8 pack.</p>";
const SHA = "c".repeat(64);
const sensor = (state: "shadow" | "enforced", over: object = {}) => ({
  id: "SEN.PERSUASION.T",
  description: "t",
  state,
  model: { name: "x/y", revision: "0".repeat(40), file: "onnx/m.onnx", sha256: SHA, pooling: "mean" as const, dim: 2 },
  weights: [8, -8],
  bias: 0,
  threshold: 0.9,
  learned: { positives: 1, negatives: 1, calibration: { negatives: 1, above_threshold: 0, max_score: 0.5 }, backtest: { caught: 1, of: 1, legit_broken: 0, weakened: 0 }, approved_by: "t", approved_at: "2026-11-10T00:00:00.000Z" },
  ...over,
});
const bundleWith = (...claim_sensors: ReturnType<typeof sensor>[]) => RuleBundle.parse({ ...getDefaultBundle(), claim_rules: [], claim_sensors });
const vectors = (v: number[], sha = SHA): SensorVectors => ({ model_sha256: sha, vectors: new Map([["shoppers in the know always reach for this product pack", v]]) });
const check = (bundle: RuleBundle, sensors?: SensorVectors, item = page(CLAIM)) =>
  checkAction({ mandate, context: [item], action, now: NOW, merchants, ...(sensors && { sensors }) }, bundle);
const ids = (r: { reasons: { rule_id: string }[] }) => r.reasons.map((x) => x.rule_id);

describe("embedding sensors in checkAction", () => {
  it("asks for the claim's text with the item's name taken out", () => {
    expect(sensorTexts({ context: [page(CLAIM)], action }, bundleWith(sensor("enforced")))).toEqual(["shoppers in the know always reach for this product pack"]);
    expect(sensorTexts({ context: [page(CLAIM)], action }, bundleWith())).toEqual([]);
    expect(sensorTexts({ context: [page(CLAIM, "trusted")], action }, bundleWith(sensor("enforced")))).toEqual([]);
  });

  it("holds for REVIEW at or above the threshold, allows below it, never BLOCKs", () => {
    const high = check(bundleWith(sensor("enforced")), vectors([1, 0]));
    expect(high.decision).toBe("REVIEW");
    expect(ids(high)).toEqual(["SEN.PERSUASION.T"]);
    expect(high.sensor_scores?.[0]?.score).toBeCloseTo(0.9997, 3);
    expect(check(bundleWith(sensor("enforced")), vectors([0, 1])).decision).toBe("ALLOW");
  });

  it("a shadow sensor is recorded but does not decide", () => {
    const r = check(bundleWith(sensor("shadow")), vectors([1, 0]));
    expect(r.decision).toBe("ALLOW");
    expect(r.shadow?.map((x) => x.rule_id)).toEqual(["SEN.PERSUASION.T"]);
  });

  it("an enforced sensor that cannot score the claim holds it (fail closed); a shadow one only records", () => {
    expect(ids(check(bundleWith(sensor("enforced"))))).toEqual(["SEN.UNAVAILABLE"]);
    expect(ids(check(bundleWith(sensor("enforced")), vectors([1, 0], "d".repeat(64))))).toEqual(["SEN.UNAVAILABLE"]);
    expect(check(bundleWith(sensor("shadow"))).decision).toBe("ALLOW");
  });

  it("does nothing when no untrusted page makes a claim about what is bought", () => {
    const r = check(bundleWith(sensor("enforced")), undefined, page("<p>Free shipping on orders over $25.</p>"));
    expect(r.decision).toBe("ALLOW");
    expect(r.sensor_scores).toBeUndefined();
  });

  it("rejects sensors that could BLOCK or whose weights do not fit the model", () => {
    expect(() => bundleWith({ ...sensor("enforced"), decision: "BLOCK" } as never)).toThrow();
    expect(() => bundleWith(sensor("enforced", { weights: [1, 2, 3] }))).toThrow();
    expect(() => bundleWith(sensor("enforced", { threshold: 0 }))).toThrow();
  });
});
