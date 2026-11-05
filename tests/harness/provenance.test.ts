import { checkAction } from "@mwf/core";
import { describe, expect, it } from "vitest";
import { loadCases, loadMerchants } from "./harness.js";

// M4's done-when, over the whole battery.
describe("provenance on the battery", () => {
  const cases = loadCases();
  const merchants = loadMerchants();
  const run = (c: (typeof cases)[number], derived_from = c.action.derived_from) =>
    checkAction({ mandate: c.mandate, context: c.context, action: { ...c.action, derived_from }, now: new Date(c.now), merchants });

  it("records a path for every hidden-text and fake-compliance attack", () => {
    for (const c of cases.filter((c) => c.category === "hidden_text" || c.category === "fake_compliance")) {
      expect(run(c).path?.length ?? 0, c.id).toBeGreaterThanOrEqual(2);
    }
  });

  // A compromised agent can leave out what it read. Value links still tie many attacks to the
  // action; the rest fall back to session-wide REVIEW, never ALLOW.
  it("never allows an attack the agent hides its sources for", () => {
    for (const c of cases.filter((c) => c.category !== "legit" && c.category !== "persuasion" && c.category !== "transaction_modification")) {
      expect(run(c, []).decision, c.id).not.toBe("ALLOW");
    }
  });

  it("links no legitimate purchase to flagged text", () => {
    for (const c of cases.filter((c) => c.category === "legit")) {
      const r = run(c);
      expect(r.decision, c.id).toBe("ALLOW");
      expect(r.path, c.id).toBeUndefined();
      expect(r.reasons.map((x) => x.rule_id), c.id).not.toContain("PROV.TAINTED_VALUE");
    }
  });
});
