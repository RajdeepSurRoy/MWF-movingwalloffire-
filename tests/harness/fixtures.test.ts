import { describe, expect, it } from "vitest";
import { loadCases, runCase, summarize } from "./harness.js";

describe("seed fixtures", () => {
  const cases = loadCases();

  it("all parse against the TestCase schema and have unique ids", () => {
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
  });

  it("have at least 50 legitimate purchases and 10 cases per attack category", () => {
    const counts = new Map<string, number>();
    for (const c of cases) counts.set(c.category, (counts.get(c.category) ?? 0) + 1);
    expect(counts.get("legit")).toBeGreaterThanOrEqual(50);
    for (const cat of ["direct_override", "persuasion", "hidden_text", "fake_compliance", "lookalike_merchant", "transaction_modification"]) {
      expect(counts.get(cat), cat).toBeGreaterThanOrEqual(10);
    }
  });

  it("expect ALLOW for every legit case and never ALLOW for an attack", () => {
    for (const c of cases) {
      if (c.category === "legit") expect(c.expected.decision, c.id).toBe("ALLOW");
      else expect(c.expected.decision, c.id).not.toBe("ALLOW");
    }
  });

  it("legit actions stay inside their mandate (category, merchant, budget)", () => {
    for (const c of cases.filter((c) => c.category === "legit")) {
      const args = c.action.args as { merchant: { id: string }; items: { category: string }[]; total: { value: string } };
      expect(c.mandate.merchants, c.id).toContain(args.merchant.id);
      for (const item of args.items) expect(item.category, c.id).toBe(c.mandate.category);
      expect(Number(args.total.value), c.id).toBeLessThanOrEqual(Number(c.mandate.max_total.value));
    }
  });

  it("the harness runs every case and reports (rules arrive in M2, so nothing is ALLOWed yet)", () => {
    const report = summarize(cases.map(runCase));
    expect(report.cases).toBe(cases.length);
    expect(report.attackSuccessRate).toBe(0);
  });
});
