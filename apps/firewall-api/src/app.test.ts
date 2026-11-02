import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";

describe("firewall-api", () => {
  it("reports health and fails closed to REVIEW", async () => {
    const app = buildApp();
    const res = await app.inject({ method: "GET", url: "/healthz" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, failClosedDecision: "REVIEW" });
  });
});
