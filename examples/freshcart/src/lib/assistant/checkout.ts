import { z } from "zod";
import type { DB } from "../db";
import { getDb } from "../db";
import type { Totals } from "../pricing";
import {
  PAYMENT_METHODS,
  StoreError,
  customerSchema,
  getCart,
  getSavedCustomer,
  placeOrder,
  priceItems,
  type OrderItemInput,
  type PaymentMethod,
} from "../store";
import { chargeSavedPayPal, getSavedPayPal, paypalEnabled, startPayPalPayment, type PayPalApi } from "../paypal";

/**
 * A checkout the shopper is in the middle of, started from the chat. It holds
 * only SKUs, quantities and delivery details: prices are recalculated from the
 * database every time it is shown and again when the order is placed.
 * Kept in memory (one per session) because it only lives for a few minutes.
 */
type PendingCheckout = {
  id: string;
  sessionId: string;
  items: OrderItemInput[] | null; // null = the whole cart
  name?: string;
  email?: string;
  address?: string;
  deliverySlot?: string;
  paymentMethod: PaymentMethod;
  updatedAt: number;
};

export type CheckoutDetails = {
  name?: string;
  email?: string;
  address?: string;
  deliverySlot?: string;
};

export type CheckoutField = keyof CheckoutDetails;

/** What the chat widget renders as the checkout card. */
export type CheckoutCardData = {
  id: string;
  source: "cart" | "buy_now";
  items: { sku: string; name: string; unit: string; quantity: number; lineTotalCents: number }[];
  totals: Totals;
  details: CheckoutDetails;
  missing: CheckoutField[];
  paymentMethod: PaymentMethod;
  paypalAvailable: boolean;
  /** The shopper's linked PayPal account (its email), charged without leaving the chat. */
  paypalLinked?: string;
};

export type PlacedOrder = { id: string; totalCents: number; paymentMethod: PaymentMethod; deliverySlot: string };

const TTL_MS = 30 * 60 * 1000;
const FIELDS: CheckoutField[] = ["name", "email", "address", "deliverySlot"];
export const FIELD_LABELS: Record<CheckoutField, string> = {
  name: "full name",
  email: "email",
  address: "delivery address",
  deliverySlot: "delivery time",
};

const fieldSchemas = {
  name: customerSchema.shape.name,
  email: customerSchema.shape.email,
  address: customerSchema.shape.address,
  deliverySlot: customerSchema.shape.deliverySlot,
};

const globalForCheckouts = globalThis as unknown as { __freshcartCheckouts?: Map<string, PendingCheckout> };
const checkouts = (globalForCheckouts.__freshcartCheckouts ??= new Map());

function newCheckoutId() {
  return "CO-" + crypto.randomUUID().slice(0, 8);
}

export function getPendingCheckout(sessionId: string): PendingCheckout | undefined {
  const pending = checkouts.get(sessionId);
  if (pending && Date.now() - pending.updatedAt > TTL_MS) {
    checkouts.delete(sessionId);
    return undefined;
  }
  return pending;
}

export function clearPendingCheckout(sessionId: string) {
  checkouts.delete(sessionId);
}

/** Validates only the fields that were given; throws a shopper-safe message. */
function cleanDetails(patch: CheckoutDetails): CheckoutDetails {
  const out: CheckoutDetails = {};
  for (const field of FIELDS) {
    const value = patch[field];
    if (value === undefined || value === "") continue;
    const parsed = fieldSchemas[field].safeParse(value);
    if (!parsed.success) throw new StoreError(parsed.error.issues[0]?.message ?? `Please check the ${FIELD_LABELS[field]}.`);
    out[field] = parsed.data;
  }
  return out;
}

export type CheckoutPatch = CheckoutDetails & {
  /** Start a "buy now" checkout for exactly these items. */
  items?: OrderItemInput[];
  /** Start a checkout for the whole cart (replaces a "buy now" one). */
  useCart?: boolean;
  paymentMethod?: PaymentMethod;
};

/**
 * Starts or updates the session's checkout and returns the card to show.
 * New checkouts are prefilled with the details from the shopper's last order.
 */
export function updateCheckout(sessionId: string, patch: CheckoutPatch, db: DB = getDb()): CheckoutCardData {
  const details = cleanDetails(patch);
  const existing = getPendingCheckout(sessionId);
  const startsNew = !existing || patch.items !== undefined || patch.useCart;
  const base: PendingCheckout = startsNew
    ? {
        id: newCheckoutId(),
        sessionId,
        items: null,
        ...(getSavedCustomer(sessionId, db) ?? {}),
        // Keep details the shopper already gave in this checkout.
        ...(existing ? pickDetails(existing) : {}),
        // A linked PayPal account is the natural default: it pays without leaving the chat.
        paymentMethod: existing?.paymentMethod ?? (paypalEnabled() && getSavedPayPal(sessionId, db) ? "paypal" : "card"),
        updatedAt: Date.now(),
      }
    : existing;
  const next: PendingCheckout = {
    ...base,
    ...details,
    items: patch.items !== undefined ? patch.items : patch.useCart ? null : base.items,
    paymentMethod: patch.paymentMethod ? choosePayment(patch.paymentMethod) : base.paymentMethod,
    updatedAt: Date.now(),
  };
  const card = toCard(next, db);
  checkouts.set(sessionId, next);
  return card;
}

function choosePayment(method: string): PaymentMethod {
  const parsed = z.enum(PAYMENT_METHODS).parse(method);
  if (parsed === "paypal" && !paypalEnabled()) throw new StoreError("PayPal isn't set up in this store yet. Use the demo card or pay on delivery.");
  return parsed;
}

function pickDetails(c: CheckoutDetails): CheckoutDetails {
  const out: CheckoutDetails = {};
  for (const field of FIELDS) if (c[field]) out[field] = c[field];
  return out;
}

function toCard(c: PendingCheckout, db: DB): CheckoutCardData {
  const priced = c.items ? priceItems(c.items, db) : getCart(c.sessionId, db);
  if (priced.lines.length === 0) throw new StoreError("Your cart is empty. Add something first, or say what you'd like to buy.");
  for (const line of priced.lines) {
    if (line.stock === 0) throw new StoreError(`${line.name} is out of stock right now.`);
    if (line.quantity > line.stock) throw new StoreError(`Only ${line.stock} of ${line.name} left in stock.`);
  }
  const details = pickDetails(c);
  return {
    id: c.id,
    source: c.items ? "buy_now" : "cart",
    items: priced.lines.map((l) => ({ sku: l.sku, name: l.name, unit: l.unit, quantity: l.quantity, lineTotalCents: l.lineTotalCents })),
    totals: priced.totals,
    details,
    missing: FIELDS.filter((f) => !details[f]),
    paymentMethod: c.paymentMethod,
    paypalAvailable: paypalEnabled(),
    paypalLinked: linkedPayPal(c.sessionId, db),
  };
}

/** How the shopper's linked PayPal account is shown, or undefined if none is linked. */
export function linkedPayPal(sessionId: string, db: DB = getDb()) {
  if (!paypalEnabled()) return undefined;
  const saved = getSavedPayPal(sessionId, db);
  return saved ? (saved.payerEmail ?? "your PayPal account") : undefined;
}

/** The session's checkout as a card, or undefined if there is none (or it no longer prices). */
export function currentCheckoutCard(sessionId: string, db: DB = getDb()): CheckoutCardData | undefined {
  const pending = getPendingCheckout(sessionId);
  if (!pending) return undefined;
  try {
    return toCard(pending, db);
  } catch {
    return undefined;
  }
}

/** Merges new details in and insists every field is there. */
function completeDetails(sessionId: string, pending: PendingCheckout, extra: CheckoutDetails = {}) {
  const merged = { ...pickDetails(pending), ...cleanDetails(extra) };
  const missing = FIELDS.filter((f) => !merged[f]);
  if (missing.length) {
    checkouts.set(sessionId, { ...pending, ...merged, updatedAt: Date.now() });
    throw new StoreError(`I still need your ${missing.map((f) => FIELD_LABELS[f]).join(", ")}.`);
  }
  return merged as Required<CheckoutDetails>;
}

/**
 * Sends the session's checkout to PayPal. The checkout stays open until PayPal
 * sends the shopper back (see /api/paypal/return), so cancelling loses nothing.
 */
export async function startCheckoutPayPal(
  sessionId: string,
  options: { checkoutId?: string; details?: CheckoutDetails; origin: string; returnPath: string },
  db: DB = getDb(),
  api?: PayPalApi,
) {
  const pending = getPendingCheckout(sessionId);
  if (!pending) throw new StoreError("There's no checkout in progress. Ask me to start one.");
  if (options.checkoutId && options.checkoutId !== pending.id) {
    throw new StoreError("This checkout was replaced by a newer one. Please use the latest card.");
  }
  const details = completeDetails(sessionId, pending, options.details);
  checkouts.set(sessionId, { ...pending, ...details, paymentMethod: "paypal", updatedAt: Date.now() });
  const items = pending.items ?? getCart(sessionId, db).lines.map((l) => ({ sku: l.sku, quantity: l.quantity }));
  return startPayPalPayment(
    sessionId,
    { items, fromCart: !pending.items, details, placedVia: "assistant", origin: options.origin, returnPath: options.returnPath },
    db,
    api,
  );
}

export type CheckoutResult = { order: PlacedOrder } | { paypal: { approveUrl: string; amountCents: number } };

/**
 * What the assistant does after the shopper says yes: places and pays for the
 * checkout in one step. Demo card, pay on delivery and a linked PayPal account
 * all finish here. PayPal without a linked account returns PayPal's approval
 * page instead: the shopper approves once there, and that links the account.
 */
export async function placeCheckout(
  sessionId: string,
  options: { checkoutId?: string; paymentMethod?: PaymentMethod; origin: string; returnPath: string },
  db: DB = getDb(),
  api?: PayPalApi,
): Promise<CheckoutResult> {
  const pending = getPendingCheckout(sessionId);
  if (!pending) throw new StoreError("There's no checkout in progress. Ask me to start one.");
  if (options.checkoutId && options.checkoutId !== pending.id) {
    throw new StoreError("This checkout was replaced by a newer one. Please use the latest one.");
  }
  const paymentMethod = options.paymentMethod ? choosePayment(options.paymentMethod) : pending.paymentMethod;
  if (paymentMethod !== "paypal") return { order: confirmCheckout(sessionId, { checkoutId: pending.id, paymentMethod }, db) };

  if (!getSavedPayPal(sessionId, db)) {
    return { paypal: await startCheckoutPayPal(sessionId, { checkoutId: pending.id, origin: options.origin, returnPath: options.returnPath }, db, api) };
  }
  const details = completeDetails(sessionId, pending);
  const items = pending.items ?? getCart(sessionId, db).lines.map((l) => ({ sku: l.sku, quantity: l.quantity }));
  const order = await chargeSavedPayPal(sessionId, { items, fromCart: !pending.items, details, placedVia: "assistant" }, db, api);
  checkouts.delete(sessionId);
  return { order: { id: order.id, totalCents: order.totals.totalCents, paymentMethod: order.paymentMethod, deliverySlot: order.deliverySlot } };
}

/**
 * Places the session's checkout as an order. `checkoutId` guards against a
 * stale card: only the latest checkout can be confirmed.
 */
export function confirmCheckout(
  sessionId: string,
  options: { checkoutId?: string; details?: CheckoutDetails; paymentMethod?: PaymentMethod } = {},
  db: DB = getDb(),
): PlacedOrder {
  const pending = getPendingCheckout(sessionId);
  if (!pending) throw new StoreError("There's no checkout in progress. Ask me to start one.");
  if (options.checkoutId && options.checkoutId !== pending.id) {
    throw new StoreError("This checkout was replaced by a newer one. Please use the latest card.");
  }
  const merged = completeDetails(sessionId, pending, options.details);
  const paymentMethod = options.paymentMethod ?? pending.paymentMethod;
  if (paymentMethod === "paypal") throw new StoreError("PayPal payments are approved on PayPal's page, not here.");
  const order = placeOrder(
    sessionId,
    { name: merged.name!, email: merged.email!, address: merged.address!, deliverySlot: merged.deliverySlot! },
    "assistant",
    db,
    { items: pending.items ?? undefined, paymentMethod },
  );
  checkouts.delete(sessionId);
  return { id: order.id, totalCents: order.totals.totalCents, paymentMethod: order.paymentMethod, deliverySlot: order.deliverySlot };
}
