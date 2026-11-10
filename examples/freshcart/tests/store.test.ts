import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { products } from "../src/lib/db/schema";
import type { DB } from "../src/lib/db";
import { addToCart, getCart, getOrder, listProducts, placeOrder, setCartQuantity, StoreError } from "../src/lib/store";
import { freshDb } from "./helpers";

const SID = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const customer = {
  name: "Ada Grocer",
  email: "ada@example.com",
  address: "12 Market Street, Springfield",
  deliverySlot: "Today, 5–7 pm",
};

let db: DB;
beforeEach(() => {
  db = freshDb();
});

describe("catalog", () => {
  it("seeds about 40 products", () => {
    expect(listProducts({}, db).length).toBeGreaterThanOrEqual(40);
  });

  it("searches across words", () => {
    const results = listProducts({ q: "greek yogurt" }, db);
    expect(results.map((p) => p.sku)).toEqual(["DRY-YOG-GRK-32"]);
  });

  it("treats LIKE wildcards in a search as literal characters", () => {
    // Unescaped, "a_b" would match any "a?b" (e.g. "Crab"); escaped it matches nothing.
    expect(listProducts({ q: "a_b" }, db)).toHaveLength(0);
    expect(listProducts({ q: "100%" }, db).map((p) => p.sku)).toContain("HSE-TOWEL-6");
  });
});

describe("cart", () => {
  it("prices lines from the database", () => {
    addToCart(SID, "PRD-AVO-4CT", 2, db);
    const cart = getCart(SID, db);
    expect(cart.lines[0].unitPriceCents).toBe(549);
    expect(cart.totals.subtotalCents).toBe(1098);
  });

  it("adds to an existing line", () => {
    addToCart(SID, "PRD-AVO-4CT", 2, db);
    addToCart(SID, "prd-avo-4ct", 1, db);
    expect(getCart(SID, db).lines[0].quantity).toBe(3);
  });

  it("rejects unknown products and too much quantity", () => {
    expect(() => addToCart(SID, "NOPE-123", 1, db)).toThrow(StoreError);
    db.update(products).set({ stock: 2 }).where(eq(products.sku, "BKY-SOUR-LOAF")).run();
    expect(() => addToCart(SID, "BKY-SOUR-LOAF", 3, db)).toThrow(/Only 2/);
    expect(() => addToCart(SID, "BKY-SOUR-LOAF", 0, db)).toThrow();
  });

  it("removes a line when quantity is set to 0", () => {
    addToCart(SID, "PRD-AVO-4CT", 2, db);
    setCartQuantity(SID, "PRD-AVO-4CT", 0, db);
    expect(getCart(SID, db).lines).toHaveLength(0);
  });

  it("keeps carts separate per session", () => {
    addToCart(SID, "PRD-AVO-4CT", 1, db);
    expect(getCart(OTHER, db).lines).toHaveLength(0);
  });
});

describe("placeOrder", () => {
  it("freezes prices, decrements stock and clears the cart", () => {
    addToCart(SID, "PNT-OLIVE-500", 3, db); // 3 × $12.99 = $38.97, free delivery
    const before = db.select().from(products).where(eq(products.sku, "PNT-OLIVE-500")).get()!.stock;
    const { id, totals } = placeOrder(SID, customer, "web", db);

    expect(totals).toMatchObject({ subtotalCents: 3897, deliveryCents: 0, totalCents: 3897 });
    expect(getCart(SID, db).lines).toHaveLength(0);
    expect(db.select().from(products).where(eq(products.sku, "PNT-OLIVE-500")).get()!.stock).toBe(before - 3);

    // A later price change doesn't rewrite the order.
    db.update(products).set({ priceCents: 1 }).where(eq(products.sku, "PNT-OLIVE-500")).run();
    const order = getOrder(SID, id, db)!;
    expect(order.items[0].unitPriceCents).toBe(1299);
    expect(order.totalCents).toBe(3897);
  });

  it("refuses an empty cart and bad details", () => {
    expect(() => placeOrder(SID, customer, "web", db)).toThrow(/empty/);
    addToCart(SID, "PRD-AVO-4CT", 1, db);
    expect(() => placeOrder(SID, { ...customer, email: "not-an-email" }, "web", db)).toThrow();
    expect(() => placeOrder(SID, { ...customer, deliverySlot: "Midnight" }, "web", db)).toThrow();
  });

  it("only shows an order to the session that placed it", () => {
    addToCart(SID, "PRD-AVO-4CT", 1, db);
    const { id } = placeOrder(SID, customer, "web", db);
    expect(getOrder(SID, id, db)).toBeDefined();
    expect(getOrder(OTHER, id, db)).toBeUndefined();
  });
});
