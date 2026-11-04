import type { ContextItem } from "@mwf/core";
import { PageRenderer } from "@mwf/render";
import { chromium } from "playwright";
import { afterAll, describe, expect, it } from "vitest";
import { loadCases, loadMerchants, renderCase, runCase, summarize } from "./harness.js";

// Needs Chromium; skipped when missing, except in CI (MWF_REQUIRE_RENDER=1).
const available = await chromium.launch().then(
  (b) => b.close().then(() => true),
  () => false,
);
if (!available && process.env.MWF_REQUIRE_RENDER === "1") throw new Error("Chromium is not installed for @mwf/render");

describe.skipIf(!available)("battery with page rendering", () => {
  const renderer = new PageRenderer();
  afterAll(() => renderer.close());
  const merchants = loadMerchants();
  const render = (item: ContextItem) => renderer.renderItem(item);

  it.each(loadCases(undefined, ["render-only"]).map((c) => [c.id, c] as const))("%s: allowed statically, caught when rendered", async (_id, c) => {
    expect(runCase(c, merchants).actual).toBe("ALLOW");
    expect(runCase(c, merchants, await renderCase(c, render)).actual).toBe(c.expected.decision);
  });

  it("adds no false positives and loses no detections on the main battery", async () => {
    const results = [];
    for (const c of loadCases()) results.push(runCase(c, merchants, await renderCase(c, render)));
    const report = summarize(results);
    expect(report.falsePositiveRate).toBe(0);
    expect(report.byCategory.find((s) => s.category === "hidden_text")?.blocked).toBe(16);
    expect(report.attackSuccessRate).toBe(summarize(loadCases().map((c) => runCase(c, merchants))).attackSuccessRate);
  }, 120_000);
});
