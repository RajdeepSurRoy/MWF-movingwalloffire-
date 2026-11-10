import path from "node:path";
import fs from "node:fs";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema";
import seedProducts from "../../../seed/products.json";

export type DB = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

const DDL = `
CREATE TABLE IF NOT EXISTS products (
  sku TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  brand TEXT NOT NULL,
  category TEXT NOT NULL,
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  currency TEXT NOT NULL DEFAULT 'USD',
  unit TEXT NOT NULL,
  stock INTEGER NOT NULL CHECK (stock >= 0),
  description TEXT NOT NULL,
  image TEXT NOT NULL,
  tags TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS products_category_idx ON products(category);

CREATE TABLE IF NOT EXISTS cart_items (
  session_id TEXT NOT NULL,
  sku TEXT NOT NULL REFERENCES products(sku),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  added_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, sku)
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  status TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  email TEXT NOT NULL,
  address TEXT NOT NULL,
  delivery_slot TEXT NOT NULL,
  subtotal_cents INTEGER NOT NULL,
  delivery_cents INTEGER NOT NULL,
  total_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  placed_via TEXT NOT NULL,
  payment_method TEXT NOT NULL DEFAULT 'cash_on_delivery',
  payment_status TEXT NOT NULL DEFAULT 'due',
  payment_ref TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS paypal_payments (
  paypal_order_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  items TEXT NOT NULL,
  from_cart INTEGER NOT NULL,
  details TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL,
  order_id TEXT,
  placed_via TEXT NOT NULL,
  return_path TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS orders_session_idx ON orders(session_id, created_at);

CREATE TABLE IF NOT EXISTS saved_paypal (
  session_id TEXT PRIMARY KEY,
  vault_id TEXT NOT NULL,
  customer_id TEXT,
  payer_email TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS order_items (
  order_id TEXT NOT NULL REFERENCES orders(id),
  sku TEXT NOT NULL,
  name TEXT NOT NULL,
  unit TEXT NOT NULL,
  unit_price_cents INTEGER NOT NULL,
  quantity INTEGER NOT NULL,
  line_total_cents INTEGER NOT NULL,
  PRIMARY KEY (order_id, sku)
);
`;

/** Drops everything and reloads the catalog from seed/products.json. */
export function resetDatabase(db: DB) {
  db.$client.exec(`
    DROP TABLE IF EXISTS saved_paypal;
    DROP TABLE IF EXISTS paypal_payments;
    DROP TABLE IF EXISTS order_items;
    DROP TABLE IF EXISTS orders;
    DROP TABLE IF EXISTS cart_items;
    DROP TABLE IF EXISTS products;
  `);
  db.$client.exec(DDL);
  seedCatalog(db);
}

function seedCatalog(db: DB) {
  db.transaction((tx) => {
    for (const p of seedProducts) {
      tx.insert(schema.products)
        .values({
          sku: p.sku,
          name: p.name,
          brand: p.brand,
          category: p.category,
          priceCents: p.price_cents,
          currency: p.currency,
          unit: p.unit,
          stock: p.stock,
          description: p.description,
          image: p.image,
          tags: p.tags,
        })
        .run();
    }
  });
}

/** Adds columns introduced after a database file was first created. */
function migrate(sqlite: Database.Database) {
  const columns = (sqlite.prepare("PRAGMA table_info(orders)").all() as { name: string }[]).map((c) => c.name);
  if (!columns.includes("payment_method")) {
    sqlite.exec("ALTER TABLE orders ADD COLUMN payment_method TEXT NOT NULL DEFAULT 'cash_on_delivery'");
  }
  if (!columns.includes("payment_status")) {
    sqlite.exec("ALTER TABLE orders ADD COLUMN payment_status TEXT NOT NULL DEFAULT 'due'");
  }
  if (!columns.includes("payment_ref")) sqlite.exec("ALTER TABLE orders ADD COLUMN payment_ref TEXT");
}

export function openDatabase(file: string): DB {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const sqlite = new Database(file);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.exec(DDL);
  migrate(sqlite);
  const db = drizzle(sqlite, { schema });
  // First run: an empty catalog gets seeded so `npm run dev` works right away.
  const { n } = sqlite.prepare("SELECT COUNT(*) AS n FROM products").get() as { n: number };
  if (n === 0) seedCatalog(db);
  return db;
}

export function databasePath() {
  return process.env.DATABASE_PATH ?? path.join(process.cwd(), "data", "freshcart.db");
}

// Reuse one connection across hot reloads in development.
const globalForDb = globalThis as unknown as { __freshcartDb?: DB };
export function getDb(): DB {
  globalForDb.__freshcartDb ??= openDatabase(databasePath());
  return globalForDb.__freshcartDb;
}
