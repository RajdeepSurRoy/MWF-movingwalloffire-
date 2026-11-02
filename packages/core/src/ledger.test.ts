import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { Ledger } from "./ledger.js";

// Simulates an attacker with direct access to the database file.
function dropGuards(db: DatabaseSync) {
  db.exec("DROP TRIGGER ledger_no_update; DROP TRIGGER ledger_no_delete;");
}

describe("Ledger", () => {
  let db: DatabaseSync;
  let ledger: Ledger;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    ledger = new Ledger(db);
    for (let i = 1; i <= 5; i++) ledger.append("decision", { n: i, decision: "REVIEW" });
  });

  it("verifies an untouched chain", () => {
    expect(ledger.verify()).toEqual({ ok: true, entries: 5 });
  });

  it("links each entry to the previous one", () => {
    const rows = db.prepare("SELECT prev_hash, hash FROM ledger ORDER BY seq").all() as { prev_hash: string; hash: string }[];
    for (let i = 1; i < rows.length; i++) expect(rows[i]!.prev_hash).toBe(rows[i - 1]!.hash);
  });

  it("refuses updates and deletes through SQL", () => {
    expect(() => db.exec("UPDATE ledger SET kind = 'x' WHERE seq = 1")).toThrow(/append-only/);
    expect(() => db.exec("DELETE FROM ledger WHERE seq = 1")).toThrow(/append-only/);
  });

  for (const column of ["payload", "kind", "created_at", "prev_hash", "hash"] as const) {
    it(`fails verification when ${column} of any row is edited`, () => {
      dropGuards(db);
      db.prepare(`UPDATE ledger SET ${column} = ? WHERE seq = 3`).run(column === "payload" ? '{"n":3,"decision":"ALLOW"}' : "tampered");
      const result = ledger.verify();
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.brokenAt).toBeLessThanOrEqual(4);
    });
  }

  it("fails verification when a middle row is deleted", () => {
    dropGuards(db);
    db.exec("DELETE FROM ledger WHERE seq = 2");
    expect(ledger.verify()).toMatchObject({ ok: false, brokenAt: 3 });
  });
});
