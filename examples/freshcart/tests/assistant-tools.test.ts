import { beforeEach, describe, expect, it } from "vitest";
import type { DB } from "../src/lib/db";
import { getCart, getProduct, listOrders } from "../src/lib/store";
import { runTool } from "../src/lib/assistant/tools";
import { clearPendingCheckout, confirmCheckout, updateCheckout } from "../src/lib/assistant/checkout";
import { productsFromReply, skusInText } from "../src/lib/assistant/markers";
import { stripMarkers } from "../src/lib/chat-text";
import { freshDb } from "./helpers";

const SID = "33333333-3333-4333-8333-333333333333";
const details = {
  name: "Ada Grocer",
  email: "ada@example.com",
  address: "12 Market Street, Springfield",
  delivery_slot: "Tomorrow, 9–11 am",
};
const run = (name: string, args: unknown) => runTool(SID, name, typeof args === "string" ? args : JSON.stringify(args), db);

let db: DB;
beforeEach(() => {
  db = freshDb();
  clearPendingCheckout(SID);
});

describe("assistant tools", () => {
  it("adds several items in one call and writes its own reply", () => {
    const out = run("add_to_cart", { items: [{ sku: "DRY-EGGS-12", quantity: 2 }, { sku: "BKY-SOUR-LOAF", quantity: 1 }] });
    expect(out.effects.cartChanged).toBe(true);
    expect(out.reply).toMatch(/^Added 2 × .+ and 1 × /);
    expect(getCart(SID, db).totals.itemCount).toBe(3);
  });

  it("reports a bad SKU without blocking the good ones, and leaves the reply to the model", () => {
    const out = run("add_to_cart", { items: [{ sku: "DRY-EGGS-12", quantity: 1 }, { sku: "NOPE-123", quantity: 1 }] });
    expect(out.reply).toBeUndefined();
    expect(out.output).toHaveProperty("failed");
    expect(getCart(SID, db).totals.itemCount).toBe(1);
  });

  it("ignores any price the model tries to send", () => {
    run("add_to_cart", { items: [{ sku: "DRY-EGGS-12", quantity: 1, price_cents: 1 }] });
    expect(getCart(SID, db).lines[0].unitPriceCents).toBe(549);
  });

  it("returns errors instead of throwing", () => {
    expect(run("add_to_cart", "{not json").output).toHaveProperty("error");
    expect(run("add_to_cart", { items: [{ sku: "DRY-EGGS-12", quantity: 500 }] }).output).toHaveProperty("error");
    expect(run("delete_store", {}).output).toHaveProperty("error");
    expect(run("checkout", {}).output).toHaveProperty("error"); // empty cart
    expect(run("confirm_order", {}).output).toHaveProperty("error"); // nothing to confirm
  });

  it("buys now without touching the cart, and pays with the demo card", () => {
    run("add_to_cart", { items: [{ sku: "BKY-SOUR-LOAF", quantity: 1 }] });
    const stockBefore = getProduct("PNT-OLIVE-500", db)!.stock;

    const checkout = run("checkout", { items: [{ sku: "PNT-OLIVE-500", quantity: 2 }], ...details });
    expect(checkout.effects.checkout?.source).toBe("buy_now");
    expect(checkout.effects.checkout?.missing).toEqual([]);
    expect(checkout.effects.checkout?.totals.totalCents).toBe(2 * 1299 + 499);

    const placed = run("confirm_order", {});
    expect(placed.effects.order?.paymentMethod).toBe("card");
    expect(placed.reply).toMatch(/paid \$30\.97 with the demo card/);
    expect(listOrders(SID, db)[0].paymentStatus).toBe("paid");
    expect(getProduct("PNT-OLIVE-500", db)!.stock).toBe(stockBefore - 2);
    expect(getCart(SID, db).lines.map((l) => l.sku)).toEqual(["BKY-SOUR-LOAF"]);
  });

  it("checks out the cart and collects missing details across turns", () => {
    run("add_to_cart", { items: [{ sku: "DRY-EGGS-12", quantity: 1 }] });
    const first = run("checkout", { name: "Ada Grocer" });
    expect(first.effects.checkout?.missing).toEqual(["email", "address", "deliverySlot"]);
    expect(first.reply).toMatch(/email, delivery address and delivery time/);

    run("checkout", { email: details.email, address: details.address, delivery_slot: details.delivery_slot, payment_method: "cash_on_delivery" });
    const placed = run("confirm_order", {});
    expect(placed.effects.order?.totalCents).toBe(549 + 499);
    expect(listOrders(SID, db)[0].paymentStatus).toBe("due");
    expect(getCart(SID, db).lines).toHaveLength(0);
  });

  it("rejects invalid details from the model", () => {
    run("add_to_cart", { items: [{ sku: "DRY-EGGS-12", quantity: 1 }] });
    expect(run("checkout", { email: "not-an-email" }).output).toHaveProperty("error");
    expect(run("checkout", { delivery_slot: "Midnight" }).output).toHaveProperty("error");
  });

  it("prefills the next checkout from the last order", () => {
    updateCheckout(SID, { items: [{ sku: "DRY-EGGS-12", quantity: 1 }], ...details, deliverySlot: details.delivery_slot }, db);
    confirmCheckout(SID, {}, db);
    const next = updateCheckout(SID, { items: [{ sku: "BKY-SOUR-LOAF", quantity: 1 }] }, db);
    expect(next.details.name).toBe("Ada Grocer");
    expect(next.missing).toEqual(["deliverySlot"]);
  });

  it("refuses a stale checkout card", () => {
    const old = updateCheckout(SID, { items: [{ sku: "DRY-EGGS-12", quantity: 1 }] }, db);
    updateCheckout(SID, { items: [{ sku: "BKY-SOUR-LOAF", quantity: 1 }] }, db);
    expect(() => confirmCheckout(SID, { checkoutId: old.id }, db)).toThrow(/replaced/);
  });
});

describe("product tags in replies", () => {
  it("finds real products and hides the tags", () => {
    const reply = "Try Sourdough [[BKY-SOUR-LOAF]] and eggs [[dry-eggs-12]], not [[FAKE-SKU-1]].";
    expect(skusInText(reply)).toEqual(["BKY-SOUR-LOAF", "DRY-EGGS-12", "FAKE-SKU-1"]);
    expect(productsFromReply(reply, db).map((p) => p.sku)).toEqual(["BKY-SOUR-LOAF", "DRY-EGGS-12"]);
    expect(stripMarkers(reply)).toBe("Try Sourdough and eggs, not.");
  });
});
