import { openDatabase, resetDatabase } from "../src/lib/db";

/** A fresh in-memory store seeded from seed/products.json. */
export function freshDb() {
  const db = openDatabase(":memory:");
  resetDatabase(db);
  return db;
}
