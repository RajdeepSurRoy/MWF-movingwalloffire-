import { sqliteTable, text, integer, primaryKey } from "drizzle-orm/sqlite-core";

export type ProductArt = { shape: string; color: string; accent: string };

export const products = sqliteTable("products", {
  sku: text("sku").primaryKey(),
  name: text("name").notNull(),
  brand: text("brand").notNull(),
  category: text("category").notNull(),
  priceCents: integer("price_cents").notNull(),
  currency: text("currency").notNull().default("USD"),
  unit: text("unit").notNull(),
  stock: integer("stock").notNull(),
  description: text("description").notNull(),
  image: text("image", { mode: "json" }).$type<ProductArt>().notNull(),
  tags: text("tags", { mode: "json" }).$type<string[]>().notNull(),
});

// The cart belongs to a browser session (cookie). It stores only SKU and
// quantity: prices are always read from `products` when totals are computed.
export const cartItems = sqliteTable(
  "cart_items",
  {
    sessionId: text("session_id").notNull(),
    sku: text("sku").notNull().references(() => products.sku),
    quantity: integer("quantity").notNull(),
    addedAt: integer("added_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.sku] })],
);

export const orders = sqliteTable("orders", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  status: text("status").notNull(), // placed | preparing | delivered | cancelled
  customerName: text("customer_name").notNull(),
  email: text("email").notNull(),
  address: text("address").notNull(),
  deliverySlot: text("delivery_slot").notNull(),
  subtotalCents: integer("subtotal_cents").notNull(),
  deliveryCents: integer("delivery_cents").notNull(),
  totalCents: integer("total_cents").notNull(),
  currency: text("currency").notNull().default("USD"),
  placedVia: text("placed_via").notNull(), // web | assistant
  paymentMethod: text("payment_method").notNull().default("cash_on_delivery"), // card | cash_on_delivery
  paymentStatus: text("payment_status").notNull().default("due"), // paid | due
  paymentRef: text("payment_ref"), // PayPal capture id
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

// Line items are frozen copies, so an order keeps its price even if the
// catalog changes later.
export const orderItems = sqliteTable(
  "order_items",
  {
    orderId: text("order_id").notNull().references(() => orders.id),
    sku: text("sku").notNull(),
    name: text("name").notNull(),
    unit: text("unit").notNull(),
    unitPriceCents: integer("unit_price_cents").notNull(),
    quantity: integer("quantity").notNull(),
    lineTotalCents: integer("line_total_cents").notNull(),
  },
  (t) => [primaryKey({ columns: [t.orderId, t.sku] })],
);

// A PayPal payment between "sent to PayPal" and "captured". It freezes what is
// being bought, so the order placed after capture matches what was paid for.
export const paypalPayments = sqliteTable("paypal_payments", {
  paypalOrderId: text("paypal_order_id").primaryKey(),
  sessionId: text("session_id").notNull(),
  items: text("items", { mode: "json" }).$type<{ sku: string; quantity: number }[]>().notNull(),
  fromCart: integer("from_cart", { mode: "boolean" }).notNull(),
  details: text("details", { mode: "json" })
    .$type<{ name: string; email: string; address: string; deliverySlot: string }>()
    .notNull(),
  amountCents: integer("amount_cents").notNull(),
  status: text("status").notNull(), // created | completed | cancelled | failed
  orderId: text("order_id"),
  placedVia: text("placed_via").notNull(), // web | assistant
  returnPath: text("return_path").notNull(), // where to send the shopper if they cancel
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

// A PayPal account the shopper linked by approving one payment on PayPal
// (PayPal "vault"). Later orders are charged to it without leaving the chat.
// Only PayPal's reference is kept, never the shopper's PayPal login.
export const savedPayPal = sqliteTable("saved_paypal", {
  sessionId: text("session_id").primaryKey(),
  vaultId: text("vault_id").notNull(),
  customerId: text("customer_id"),
  payerEmail: text("payer_email"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

export type Product = typeof products.$inferSelect;
export type Order = typeof orders.$inferSelect;
export type OrderItem = typeof orderItems.$inferSelect;
