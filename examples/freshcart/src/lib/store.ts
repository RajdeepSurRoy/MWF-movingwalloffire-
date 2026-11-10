import { and, asc, desc, eq, inArray, like, or, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, type DB } from "./db";
import { cartItems, orderItems, orders, products, type Product } from "./db/schema";
import { computeTotals, type Totals } from "./pricing";
import { CATEGORY_SLUGS, DELIVERY_SLOTS, MAX_QTY_PER_ITEM } from "./catalog";

/** An error whose message is safe to show to a shopper. */
export class StoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreError";
  }
}

// ---------- Validation ----------

export const skuSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9-]{3,40}$/, "That doesn't look like a valid product code.");

export const quantitySchema = z
  .number()
  .int("Quantity must be a whole number.")
  .min(1, "Quantity must be at least 1.")
  .max(MAX_QTY_PER_ITEM, `You can add up to ${MAX_QTY_PER_ITEM} of one item.`);

export const productQuerySchema = z.object({
  q: z.string().trim().max(80).optional(),
  category: z.enum(CATEGORY_SLUGS).optional(),
  limit: z.number().int().min(1).max(60).optional(),
});

export const customerSchema = z.object({
  name: z.string().trim().min(2, "Please enter your full name.").max(80),
  email: z.string().trim().toLowerCase().pipe(z.email("Please enter a valid email address.")),
  address: z.string().trim().min(8, "Please enter a full delivery address.").max(200),
  deliverySlot: z.string().pipe(z.enum(DELIVERY_SLOTS, { message: "Please choose a delivery time." })),
});
export type CustomerDetails = z.infer<typeof customerSchema>;

// ---------- Catalog ----------

function escapeLike(value: string) {
  return value.replace(/[\\%_]/g, (m) => `\\${m}`);
}

export function listProducts(input: z.input<typeof productQuerySchema> = {}, db: DB = getDb()) {
  const { q, category, limit } = productQuerySchema.parse(input);
  const filters = [];
  if (category) filters.push(eq(products.category, category));
  if (q) {
    // Every word must match somewhere: "greek yogurt" finds the yogurt.
    for (const word of q.split(/\s+/).filter(Boolean).slice(0, 6)) {
      const pattern = `%${escapeLike(word)}%`;
      filters.push(
        or(
          sql`${products.name} LIKE ${pattern} ESCAPE '\\'`,
          sql`${products.brand} LIKE ${pattern} ESCAPE '\\'`,
          sql`${products.category} LIKE ${pattern} ESCAPE '\\'`,
          sql`${products.tags} LIKE ${pattern} ESCAPE '\\'`,
          sql`${products.description} LIKE ${pattern} ESCAPE '\\'`,
        )!,
      );
    }
  }
  return db
    .select()
    .from(products)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(asc(products.category), asc(products.name))
    .limit(limit ?? 60)
    .all();
}

export function listFeatured(db: DB = getDb()) {
  return db.select().from(products).where(like(products.tags, '%"featured"%')).orderBy(asc(products.name)).all();
}

export function getProduct(sku: string, db: DB = getDb()): Product | undefined {
  const parsed = skuSchema.safeParse(sku);
  if (!parsed.success) return undefined;
  return db.select().from(products).where(eq(products.sku, parsed.data)).get();
}

// ---------- Cart ----------

export type CartLine = {
  sku: string;
  name: string;
  brand: string;
  unit: string;
  image: Product["image"];
  stock: number;
  unitPriceCents: number;
  quantity: number;
  lineTotalCents: number;
};
export type Cart = { lines: CartLine[]; totals: Totals };

export function getCart(sessionId: string | null, db: DB = getDb()): Cart {
  if (!sessionId) return { lines: [], totals: computeTotals([]) };
  const rows = db
    .select({ item: cartItems, product: products })
    .from(cartItems)
    .innerJoin(products, eq(cartItems.sku, products.sku))
    .where(eq(cartItems.sessionId, sessionId))
    .orderBy(asc(cartItems.addedAt))
    .all();
  const lines: CartLine[] = rows.map(({ item, product }) => ({
    sku: product.sku,
    name: product.name,
    brand: product.brand,
    unit: product.unit,
    image: product.image,
    stock: product.stock,
    unitPriceCents: product.priceCents,
    quantity: item.quantity,
    lineTotalCents: product.priceCents * item.quantity,
  }));
  return { lines, totals: computeTotals(lines) };
}

function requireProduct(db: DB, sku: string) {
  const product = getProduct(sku, db);
  if (!product) throw new StoreError(`We couldn't find a product with code ${sku}.`);
  return product;
}

function checkStock(product: Product, quantity: number) {
  if (product.stock === 0) throw new StoreError(`${product.name} is out of stock right now.`);
  if (quantity > product.stock) {
    throw new StoreError(`Only ${product.stock} of ${product.name} left in stock.`);
  }
}

/** Adds to the existing quantity (or creates the line). */
export function addToCart(sessionId: string, sku: string, quantity: number, db: DB = getDb()) {
  const qty = quantitySchema.parse(quantity);
  const product = requireProduct(db, sku);
  const existing = db
    .select()
    .from(cartItems)
    .where(and(eq(cartItems.sessionId, sessionId), eq(cartItems.sku, product.sku)))
    .get();
  const next = (existing?.quantity ?? 0) + qty;
  if (next > MAX_QTY_PER_ITEM) {
    throw new StoreError(`You can have up to ${MAX_QTY_PER_ITEM} of ${product.name} in your cart.`);
  }
  checkStock(product, next);
  db.insert(cartItems)
    .values({ sessionId, sku: product.sku, quantity: next, addedAt: new Date() })
    .onConflictDoUpdate({ target: [cartItems.sessionId, cartItems.sku], set: { quantity: next } })
    .run();
  return getCart(sessionId, db);
}

/** Sets an exact quantity. Zero removes the line. */
export function setCartQuantity(sessionId: string, sku: string, quantity: number, db: DB = getDb()) {
  if (quantity === 0) return removeFromCart(sessionId, sku, db);
  const qty = quantitySchema.parse(quantity);
  const product = requireProduct(db, sku);
  checkStock(product, qty);
  const result = db
    .update(cartItems)
    .set({ quantity: qty })
    .where(and(eq(cartItems.sessionId, sessionId), eq(cartItems.sku, product.sku)))
    .run();
  if (result.changes === 0) {
    db.insert(cartItems).values({ sessionId, sku: product.sku, quantity: qty, addedAt: new Date() }).run();
  }
  return getCart(sessionId, db);
}

export function removeFromCart(sessionId: string, sku: string, db: DB = getDb()) {
  const parsed = skuSchema.safeParse(sku);
  if (parsed.success) {
    db.delete(cartItems)
      .where(and(eq(cartItems.sessionId, sessionId), eq(cartItems.sku, parsed.data)))
      .run();
  }
  return getCart(sessionId, db);
}

// ---------- Orders ----------

function newOrderId() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return "FC-" + Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

export const PAYMENT_METHODS = ["card", "paypal", "cash_on_delivery"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export const PAYMENT_LABELS: Record<PaymentMethod, string> = {
  card: "Demo card (paid now, nothing is charged)",
  paypal: "PayPal (sandbox test account)",
  cash_on_delivery: "Pay on delivery",
};

export type OrderItemInput = { sku: string; quantity: number };

/**
 * Prices a list of SKUs straight from the database, for "buy now" orders that
 * skip the cart. Repeated SKUs are merged.
 */
export function priceItems(items: OrderItemInput[], db: DB = getDb()): Cart {
  const merged = new Map<string, number>();
  for (const item of items) {
    const sku = skuSchema.parse(item.sku);
    merged.set(sku, (merged.get(sku) ?? 0) + quantitySchema.parse(item.quantity));
  }
  if (merged.size === 0) throw new StoreError("Pick at least one item to buy.");
  const lines: CartLine[] = [...merged].map(([sku, quantity]) => {
    const product = requireProduct(db, sku);
    if (quantity > MAX_QTY_PER_ITEM) throw new StoreError(`You can buy up to ${MAX_QTY_PER_ITEM} of ${product.name}.`);
    return {
      sku: product.sku,
      name: product.name,
      brand: product.brand,
      unit: product.unit,
      image: product.image,
      stock: product.stock,
      unitPriceCents: product.priceCents,
      quantity,
      lineTotalCents: product.priceCents * quantity,
    };
  });
  return { lines, totals: computeTotals(lines) };
}

export type OrderOptions = {
  /** Buy exactly these items instead of the cart (the cart is left alone). */
  items?: OrderItemInput[];
  paymentMethod?: PaymentMethod;
  /** The provider's payment id. Required for PayPal: only a captured payment can place a PayPal order. */
  paymentRef?: string;
  /** With `items`: remove those items from the cart afterwards (a paid-for cart snapshot). */
  clearCart?: boolean;
};

/**
 * Turns the session's cart (or a "buy now" item list) into an order. Prices and
 * totals come from the database inside one transaction and stock is
 * decremented. A cart order clears the cart. Payment is simulated: "card"
 * marks the order paid without charging anything.
 */
export function placeOrder(
  sessionId: string,
  details: z.input<typeof customerSchema>,
  placedVia: "web" | "assistant",
  db: DB = getDb(),
  options: OrderOptions = {},
) {
  const customer = customerSchema.parse(details);
  const paymentMethod = z.enum(PAYMENT_METHODS).parse(options.paymentMethod ?? "cash_on_delivery");
  if (paymentMethod === "paypal" && !options.paymentRef) throw new StoreError("PayPal orders need a completed PayPal payment.");
  return db.transaction((tx) => {
    const txDb = tx as unknown as DB;
    const fromCart = !options.items;
    const cart = fromCart ? getCart(sessionId, txDb) : priceItems(options.items!, txDb);
    if (cart.lines.length === 0) throw new StoreError("Your cart is empty.");
    for (const line of cart.lines) {
      if (line.quantity > line.stock) {
        throw new StoreError(
          line.stock === 0
            ? `${line.name} just sold out.${fromCart ? " Please remove it from your cart." : ""}`
            : `Only ${line.stock} of ${line.name} left. Please lower the quantity.`,
        );
      }
    }
    const id = newOrderId();
    tx.insert(orders)
      .values({
        id,
        sessionId,
        status: "placed",
        customerName: customer.name,
        email: customer.email,
        address: customer.address,
        deliverySlot: customer.deliverySlot,
        subtotalCents: cart.totals.subtotalCents,
        deliveryCents: cart.totals.deliveryCents,
        totalCents: cart.totals.totalCents,
        currency: "USD",
        placedVia,
        paymentMethod,
        paymentStatus: paymentMethod === "cash_on_delivery" ? "due" : "paid",
        paymentRef: options.paymentRef ?? null,
        createdAt: new Date(),
      })
      .run();
    for (const line of cart.lines) {
      tx.insert(orderItems)
        .values({
          orderId: id,
          sku: line.sku,
          name: line.name,
          unit: line.unit,
          unitPriceCents: line.unitPriceCents,
          quantity: line.quantity,
          lineTotalCents: line.lineTotalCents,
        })
        .run();
      tx.update(products)
        .set({ stock: sql`${products.stock} - ${line.quantity}` })
        .where(eq(products.sku, line.sku))
        .run();
    }
    if (fromCart) {
      tx.delete(cartItems).where(eq(cartItems.sessionId, sessionId)).run();
    } else if (options.clearCart) {
      // A paid-for snapshot of the cart: remove just those items, keeping
      // anything added after the payment started.
      const skus = cart.lines.map((l) => l.sku);
      tx.delete(cartItems).where(and(eq(cartItems.sessionId, sessionId), inArray(cartItems.sku, skus))).run();
    }
    return { id, totals: cart.totals, paymentMethod, deliverySlot: customer.deliverySlot };
  });
}

/** Name, email and address from the session's latest order, to prefill the next one. */
export function getSavedCustomer(sessionId: string | null, db: DB = getDb()) {
  if (!sessionId) return undefined;
  return db
    .select({ name: orders.customerName, email: orders.email, address: orders.address })
    .from(orders)
    .where(eq(orders.sessionId, sessionId))
    .orderBy(desc(orders.createdAt))
    .get();
}

export function listOrders(sessionId: string | null, db: DB = getDb()) {
  if (!sessionId) return [];
  const rows = db.select().from(orders).where(eq(orders.sessionId, sessionId)).orderBy(desc(orders.createdAt)).all();
  return rows.map((order) => ({
    ...order,
    items: db.select().from(orderItems).where(eq(orderItems.orderId, order.id)).all(),
  }));
}

/** Orders are only visible to the session that placed them. */
export function getOrder(sessionId: string | null, id: string, db: DB = getDb()) {
  if (!sessionId || !/^FC-[A-Z0-9]{6}$/.test(id)) return undefined;
  const order = db
    .select()
    .from(orders)
    .where(and(eq(orders.id, id), eq(orders.sessionId, sessionId)))
    .get();
  if (!order) return undefined;
  return { ...order, items: db.select().from(orderItems).where(eq(orderItems.orderId, id)).all() };
}

/** Turns any thrown error into a message safe for the shopper (no stack traces). */
export function friendlyError(error: unknown): string {
  if (error instanceof StoreError) return error.message;
  if (error instanceof z.ZodError) return error.issues[0]?.message ?? "Some details look invalid.";
  console.error(error);
  return "Something went wrong on our side. Please try again.";
}
