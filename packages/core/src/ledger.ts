import type { DatabaseSync } from "node:sqlite";
import { canonicalize, sha256Hex } from "./canonical.js";

export const GENESIS_HASH = "0".repeat(64);

export interface LedgerEntry {
  seq: number;
  created_at: string;
  kind: string;
  payload: string;
  prev_hash: string;
  hash: string;
}

export type VerifyResult = { ok: true; entries: number } | { ok: false; entries: number; brokenAt: number; problem: string };

function entryHash(e: Omit<LedgerEntry, "hash">): string {
  return sha256Hex([e.prev_hash, e.seq, e.created_at, e.kind, e.payload].join("\n"));
}

// Append-only, hash-chained log: each entry commits to the previous entry's hash, so
// editing, deleting or reordering any row breaks verification from that row on.
// (Truncating the newest rows needs an external anchor of the head hash — later phase.)
export class Ledger {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ledger (
        seq        INTEGER PRIMARY KEY,
        created_at TEXT    NOT NULL,
        kind       TEXT    NOT NULL,
        payload    TEXT    NOT NULL,
        prev_hash  TEXT    NOT NULL,
        hash       TEXT    NOT NULL UNIQUE
      );
      CREATE TRIGGER IF NOT EXISTS ledger_no_update BEFORE UPDATE ON ledger
        BEGIN SELECT RAISE(ABORT, 'ledger is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS ledger_no_delete BEFORE DELETE ON ledger
        BEGIN SELECT RAISE(ABORT, 'ledger is append-only'); END;
    `);
  }

  append(kind: string, payload: unknown, now: Date = new Date()): LedgerEntry {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const head = this.db.prepare("SELECT seq, hash FROM ledger ORDER BY seq DESC LIMIT 1").get() as
        | { seq: number; hash: string }
        | undefined;
      const base = {
        seq: (head?.seq ?? 0) + 1,
        created_at: now.toISOString(),
        kind,
        payload: canonicalize(payload),
        prev_hash: head?.hash ?? GENESIS_HASH,
      };
      const entry: LedgerEntry = { ...base, hash: entryHash(base) };
      this.db
        .prepare("INSERT INTO ledger (seq, created_at, kind, payload, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?)")
        .run(entry.seq, entry.created_at, entry.kind, entry.payload, entry.prev_hash, entry.hash);
      this.db.exec("COMMIT");
      return entry;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  verify(): VerifyResult {
    const rows = this.db.prepare("SELECT * FROM ledger ORDER BY seq").all() as unknown as LedgerEntry[];
    let prev = GENESIS_HASH;
    for (const [i, row] of rows.entries()) {
      const fail = (problem: string): VerifyResult => ({ ok: false, entries: rows.length, brokenAt: row.seq, problem });
      if (row.seq !== i + 1) return fail(`expected seq ${i + 1}, found ${row.seq} (row missing or reordered)`);
      if (row.prev_hash !== prev) return fail("prev_hash does not match the previous entry");
      if (entryHash(row) !== row.hash) return fail("entry contents do not match its hash");
      prev = row.hash;
    }
    return { ok: true, entries: rows.length };
  }
}
