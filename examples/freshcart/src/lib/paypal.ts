import { and, eq } from "drizzle-orm";
import type { DB } from "./db";
import { getDb } from "./db";
import { paypalPayments, savedPayPal } from "./db/schema";
import {
  StoreError,
  customerSchema,
  placeOrder,
  priceItems,
  type CustomerDetails,
  type OrderItemInput,
} from "./store";

// PayPal Orders v2 over plain fetch. Sandbox only: this is a demo store, so
// there is deliberately no switch to PayPal's live API.
const SANDBOX_API = "https://api-m.sandbox.paypal.com";

export function paypalEnabled() {
  return Boolean(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET);
}

function centsToValue(cents: number) {
  return (cents / 100).toFixed(2);
}

// ---------- HTTP ----------

export type CaptureResult = {
  status: string;
  captureId?: string;
  amountValue?: string;
  currency?: string;
  /** Set when the shopper agreed on PayPal to save their account for later payments. */
  vault?: { id: string; customerId?: string; email?: string };
};

export type PayPalApi = {
  /** A payment the shopper approves on PayPal. It also asks PayPal to save the account for next time. */
  createOrder(input: { amountCents: number; reference: string; description: string; returnUrl: string; cancelUrl: string }): Promise<{
    id: string;
    approveUrl: string;
  }>;
  captureOrder(id: string): Promise<CaptureResult>;
  /** What PayPal holds for an order the shopper approved: its status, amount and payee, from PayPal's API. */
  getOrder(id: string): Promise<HeldOrder>;
  /** Charges a saved PayPal account straight away, with no PayPal page. */
  chargeSaved(input: { amountCents: number; reference: string; description: string; vaultId: string }): Promise<CaptureResult & { id: string }>;
};

/** An approved PayPal order before capture, as PayPal's API reports it (not as any page shows it). */
export type HeldOrder = { id: string; status: string; amountValue?: string; currency?: string; payeeEmail?: string; payeeId?: string };

/**
 * Asked right before a capture, with what PayPal holds. It throws to stop the capture; what it
 * returns is called once the capture is done, with PayPal's capture id (for the record).
 */
export type CaptureGuard = (input: {
  sessionId: string;
  held: HeldOrder;
  items: { sku: string; quantity: number }[];
  amountCents: number;
}) => Promise<((captureId: string) => Promise<void>) | void>;

/** PayPal said no. `issue` is PayPal's reason code, e.g. INSTRUMENT_DECLINED. */
export class PayPalRequestError extends StoreError {
  constructor(
    message: string,
    readonly status: number,
    readonly issue?: string,
  ) {
    super(message);
  }
}

const globalForPayPal = globalThis as unknown as { __freshcartPayPalToken?: { value: string; expires: number } };

async function accessToken() {
  const cached = globalForPayPal.__freshcartPayPalToken;
  if (cached && cached.expires > Date.now() + 60_000) return cached.value;
  const id = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_CLIENT_SECRET;
  if (!id || !secret) throw new StoreError("PayPal isn't set up. Add PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET to .env.local.");
  const res = await fetch(`${SANDBOX_API}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
    cache: "no-store",
  });
  if (!res.ok) {
    console.error("PayPal token error", res.status, await res.text());
    throw new StoreError(
      res.status === 401
        ? "PayPal rejected the sandbox keys. Check PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in .env.local."
        : "Couldn't reach PayPal. Please try again.",
    );
  }
  const data = (await res.json()) as { access_token: string; expires_in: number };
  globalForPayPal.__freshcartPayPalToken = { value: data.access_token, expires: Date.now() + data.expires_in * 1000 };
  return data.access_token;
}

async function paypalFetch(path: string, body: unknown, requestId: string) {
  const res = await fetch(`${SANDBOX_API}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${await accessToken()}`,
      "Content-Type": "application/json",
      // Makes retries safe: PayPal treats the same id as the same request.
      "PayPal-Request-Id": requestId,
    },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error("PayPal error", path, res.status, JSON.stringify(data));
    throw new PayPalRequestError("PayPal couldn't process this payment. Please try again.", res.status, data.details?.[0]?.issue);
  }
  return data;
}

async function paypalGet(path: string) {
  const res = await fetch(`${SANDBOX_API}${path}`, { headers: { Authorization: `Bearer ${await accessToken()}` }, cache: "no-store" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error("PayPal error", path, res.status, JSON.stringify(data));
    throw new PayPalRequestError("PayPal couldn't find this payment. Please try again.", res.status, data.details?.[0]?.issue);
  }
  return data;
}

type PayPalOrderResponse = {
  id: string;
  status: string;
  payment_source?: { paypal?: { email_address?: string; attributes?: { vault?: { id?: string; status?: string; customer?: { id?: string } } } } };
  purchase_units?: {
    amount?: { value: string; currency_code: string };
    payee?: { email_address?: string; merchant_id?: string };
    payments?: { captures?: { id: string; status: string; amount: { value: string; currency_code: string } }[] };
  }[];
};

function readCapture(data: PayPalOrderResponse): CaptureResult {
  const capture = data.purchase_units?.[0]?.payments?.captures?.[0];
  const paypal = data.payment_source?.paypal;
  const vault = paypal?.attributes?.vault;
  return {
    status: data.status,
    captureId: capture?.id,
    amountValue: capture?.amount?.value,
    currency: capture?.amount?.currency_code,
    vault: vault?.id && vault.status === "VAULTED" ? { id: vault.id, customerId: vault.customer?.id, email: paypal?.email_address } : undefined,
  };
}

function purchaseUnit(reference: string, description: string, amountCents: number) {
  return { reference_id: reference, description, amount: { currency_code: "USD", value: centsToValue(amountCents) } };
}

export const paypalApi: PayPalApi = {
  async createOrder({ amountCents, reference, description, returnUrl, cancelUrl }) {
    const data = await paypalFetch(
      "/v2/checkout/orders",
      {
        intent: "CAPTURE",
        purchase_units: [purchaseUnit(reference, description, amountCents)],
        payment_source: {
          paypal: {
            // Save the account on PayPal's side once this payment succeeds, so the
            // assistant can charge it next time without sending the shopper away.
            attributes: { vault: { store_in_vault: "ON_SUCCESS", usage_type: "MERCHANT", customer_type: "CONSUMER" } },
            experience_context: {
              brand_name: "FreshCart (demo)",
              shipping_preference: "NO_SHIPPING",
              user_action: "PAY_NOW",
              // Open on the login page: in the sandbox, paying as a guest with a card often fails on PayPal's side.
              landing_page: "LOGIN",
              return_url: returnUrl,
              cancel_url: cancelUrl,
            },
          },
        },
      },
      `create-${reference}`,
    );
    const approveUrl = (data.links as { rel: string; href: string }[] | undefined)?.find(
      (l) => l.rel === "payer-action" || l.rel === "approve",
    )?.href;
    if (!data.id || !approveUrl) throw new StoreError("PayPal didn't return a payment page. Please try again.");
    return { id: data.id, approveUrl };
  },
  async captureOrder(id) {
    return readCapture(await paypalFetch(`/v2/checkout/orders/${encodeURIComponent(id)}/capture`, {}, `capture-${id}`));
  },
  async getOrder(id) {
    const data = (await paypalGet(`/v2/checkout/orders/${encodeURIComponent(id)}`)) as PayPalOrderResponse;
    const unit = data.purchase_units?.[0];
    return {
      id: data.id,
      status: data.status,
      amountValue: unit?.amount?.value,
      currency: unit?.amount?.currency_code,
      payeeEmail: unit?.payee?.email_address,
      payeeId: unit?.payee?.merchant_id,
    };
  },
  async chargeSaved({ amountCents, reference, description, vaultId }) {
    let data: PayPalOrderResponse = await paypalFetch(
      "/v2/checkout/orders",
      {
        intent: "CAPTURE",
        purchase_units: [purchaseUnit(reference, description, amountCents)],
        payment_source: { paypal: { vault_id: vaultId } },
      },
      `charge-${reference}`,
    );
    // A saved account is normally captured as the order is created; capture it if not.
    if (data.status === "APPROVED") data = await paypalFetch(`/v2/checkout/orders/${encodeURIComponent(data.id)}/capture`, {}, `capture-${data.id}`);
    return { id: data.id, ...readCapture(data) };
  },
};

// ---------- Linked accounts ----------

/** The shopper's linked PayPal account, if they have one. */
export function getSavedPayPal(sessionId: string, db: DB = getDb()) {
  return db.select().from(savedPayPal).where(eq(savedPayPal.sessionId, sessionId)).get();
}

/** Unlinks the shopper's PayPal account. Returns false if none was linked. */
export function forgetSavedPayPal(sessionId: string, db: DB = getDb()) {
  return db.delete(savedPayPal).where(eq(savedPayPal.sessionId, sessionId)).run().changes > 0;
}

function rememberPayPal(sessionId: string, vault: NonNullable<CaptureResult["vault"]>, db: DB) {
  const row = { vaultId: vault.id, customerId: vault.customerId ?? null, payerEmail: vault.email ?? null, createdAt: new Date() };
  db.insert(savedPayPal).values({ sessionId, ...row }).onConflictDoUpdate({ target: savedPayPal.sessionId, set: row }).run();
}

// ---------- Payments ----------

export type StartPayPalInput = {
  items: OrderItemInput[];
  fromCart: boolean;
  details: CustomerDetails | Record<string, string>;
  placedVia: "web" | "assistant";
  /** Site origin for PayPal to send the shopper back to, e.g. http://localhost:3000 */
  origin: string;
  /** Where to send the shopper if they cancel on PayPal. */
  returnPath: string;
};

/**
 * Prices the items from the database, creates a PayPal order for exactly that
 * total and records what is being bought. Returns PayPal's approval page.
 */
export async function startPayPalPayment(
  sessionId: string,
  input: StartPayPalInput,
  db: DB = getDb(),
  api: PayPalApi = paypalApi,
) {
  if (api === paypalApi && !paypalEnabled()) {
    throw new StoreError("PayPal isn't set up yet. Choose another payment method.");
  }
  const { details, priced } = priceForPayment(input.items, input.details, db);
  const reference = newReference();
  const order = await api.createOrder({
    amountCents: priced.totals.totalCents,
    reference,
    description: `FreshCart demo order (${priced.totals.itemCount} items)`,
    returnUrl: `${input.origin}/api/paypal/return`,
    cancelUrl: `${input.origin}/api/paypal/cancel`,
  });
  db.insert(paypalPayments)
    .values({
      paypalOrderId: order.id,
      sessionId,
      items: priced.lines.map((l) => ({ sku: l.sku, quantity: l.quantity })),
      fromCart: input.fromCart,
      details,
      amountCents: priced.totals.totalCents,
      status: "created",
      placedVia: input.placedVia,
      returnPath: safePath(input.returnPath),
      createdAt: new Date(),
    })
    .run();
  return { approveUrl: order.approveUrl, amountCents: priced.totals.totalCents };
}

/** Prices the items from the database and checks stock before any money moves. */
function priceForPayment(items: OrderItemInput[], rawDetails: StartPayPalInput["details"], db: DB) {
  const details = customerSchema.parse(rawDetails);
  const priced = priceItems(items, db);
  for (const line of priced.lines) {
    if (line.quantity > line.stock) {
      throw new StoreError(line.stock === 0 ? `${line.name} is out of stock right now.` : `Only ${line.stock} of ${line.name} left in stock.`);
    }
  }
  return { details, priced };
}

function newReference() {
  return "FCP-" + crypto.randomUUID().slice(0, 12);
}

// Sessions with a saved-account charge in flight, so a double "yes" can't pay twice.
const globalForCharges = globalThis as unknown as { __freshcartCharging?: Set<string> };
const charging = (globalForCharges.__freshcartCharging ??= new Set());

/**
 * Pays with the shopper's linked PayPal account and places the order, all on
 * the server: the assistant uses this after the shopper says yes. Like the
 * PayPal-page flow, the captured amount must match the database total.
 */
export async function chargeSavedPayPal(
  sessionId: string,
  input: Omit<StartPayPalInput, "origin" | "returnPath">,
  db: DB = getDb(),
  api: PayPalApi = paypalApi,
) {
  const saved = getSavedPayPal(sessionId, db);
  if (!saved) throw new StoreError("There's no PayPal account linked yet.");
  if (charging.has(sessionId)) throw new StoreError("I'm already placing this order. One moment.");
  charging.add(sessionId);
  try {
    const { details, priced } = priceForPayment(input.items, input.details, db);
    const amountCents = priced.totals.totalCents;
    let charge: Awaited<ReturnType<PayPalApi["chargeSaved"]>>;
    try {
      charge = await api.chargeSaved({
        amountCents,
        reference: newReference(),
        description: `FreshCart demo order (${priced.totals.itemCount} items)`,
        vaultId: saved.vaultId,
      });
    } catch (error) {
      // The account was unlinked or declined on PayPal's side: stop using it.
      if (error instanceof PayPalRequestError && error.status >= 400 && error.status < 500) {
        forgetSavedPayPal(sessionId, db);
        throw new StoreError("PayPal declined your linked account, so I've unlinked it. Nothing was charged. Say yes again to approve this payment on PayPal.");
      }
      throw error;
    }
    if (charge.status !== "COMPLETED" || !charge.captureId) throw new StoreError("PayPal didn't complete the payment, so nothing was ordered.");

    // Record the payment before placing the order, so a failure below is traceable.
    db.insert(paypalPayments)
      .values({
        paypalOrderId: charge.id,
        sessionId,
        items: priced.lines.map((l) => ({ sku: l.sku, quantity: l.quantity })),
        fromCart: input.fromCart,
        details,
        amountCents,
        status: "capturing",
        placedVia: input.placedVia,
        returnPath: "/",
        createdAt: new Date(),
      })
      .run();
    const fail = (message: string) => {
      db.update(paypalPayments).set({ status: "failed" }).where(eq(paypalPayments.paypalOrderId, charge.id)).run();
      return new StoreError(message);
    };
    if (charge.currency !== "USD" || charge.amountValue !== centsToValue(amountCents)) {
      throw fail("The amount PayPal charged doesn't match the order total, so the order wasn't placed.");
    }
    let order: ReturnType<typeof placeOrder>;
    try {
      order = placeOrder(sessionId, details, input.placedVia, db, {
        items: priced.lines.map((l) => ({ sku: l.sku, quantity: l.quantity })),
        paymentMethod: "paypal",
        paymentRef: charge.captureId,
        clearCart: input.fromCart,
      });
    } catch (error) {
      console.error("Order after saved PayPal charge failed", charge.id, error);
      throw fail(
        `Your PayPal sandbox payment went through, but the order couldn't be placed: ${error instanceof StoreError ? error.message : "please contact support"}`,
      );
    }
    db.update(paypalPayments).set({ status: "completed", orderId: order.id }).where(eq(paypalPayments.paypalOrderId, charge.id)).run();
    return order;
  } finally {
    charging.delete(sessionId);
  }
}

/** Only same-site paths, so a crafted value can't redirect elsewhere. */
function safePath(path: string) {
  return /^\/(?!\/)[\w\-./?=&%]*$/.test(path) ? path : "/";
}

function findPayment(sessionId: string, paypalOrderId: string, db: DB) {
  return db
    .select()
    .from(paypalPayments)
    .where(and(eq(paypalPayments.paypalOrderId, paypalOrderId), eq(paypalPayments.sessionId, sessionId)))
    .get();
}

/**
 * Called when PayPal sends the shopper back. Captures the payment, checks the
 * captured amount against what was recorded, then places the store order.
 * Safe to call twice (a page refresh): the second call returns the same order.
 */
export async function completePayPalPayment(
  sessionId: string,
  paypalOrderId: string,
  db: DB = getDb(),
  api: PayPalApi = paypalApi,
  guard?: CaptureGuard,
): Promise<{ orderId: string; placedVia: string; returnPath: string }> {
  const payment = findPayment(sessionId, paypalOrderId, db);
  if (!payment) throw new StoreError("We couldn't find this PayPal payment.");
  if (payment.status === "completed" && payment.orderId) {
    return { orderId: payment.orderId, placedVia: payment.placedVia, returnPath: payment.returnPath };
  }

  // Claim the payment so two simultaneous returns can't both capture it.
  const claimed = db
    .update(paypalPayments)
    .set({ status: "capturing" })
    .where(and(eq(paypalPayments.paypalOrderId, paypalOrderId), eq(paypalPayments.status, "created")))
    .run();
  if (claimed.changes === 0) throw new StoreError("This PayPal payment was already handled.");

  const fail = (message: string) => {
    db.update(paypalPayments).set({ status: "failed" }).where(eq(paypalPayments.paypalOrderId, paypalOrderId)).run();
    return new StoreError(message);
  };

  // Before any money moves: what PayPal holds (amount, payee) goes to the guard, which can stop it.
  let captured: ((captureId: string) => Promise<void>) | void = undefined;
  if (guard) {
    try {
      const held = await api.getOrder(paypalOrderId);
      captured = await guard({ sessionId, held, items: payment.items, amountCents: payment.amountCents });
    } catch (error) {
      throw fail(error instanceof StoreError ? error.message : "The store couldn't check this payment, so it wasn't taken.");
    }
  }

  let capture: Awaited<ReturnType<PayPalApi["captureOrder"]>>;
  try {
    capture = await api.captureOrder(paypalOrderId);
  } catch (error) {
    throw fail(error instanceof StoreError ? error.message : "PayPal couldn't complete the payment.");
  }
  if (capture.status !== "COMPLETED" || !capture.captureId) throw fail("PayPal didn't complete the payment.");
  if (capture.currency !== "USD" || capture.amountValue !== centsToValue(payment.amountCents)) {
    throw fail("The amount PayPal captured doesn't match the order total.");
  }
  if (captured) await captured(capture.captureId).catch((error) => console.error("Recording the capture failed", error));
  // The shopper agreed on PayPal to save the account: later orders can be paid from the chat.
  if (capture.vault) rememberPayPal(sessionId, capture.vault, db);

  let orderId: string;
  try {
    orderId = placeOrder(sessionId, payment.details, payment.placedVia === "web" ? "web" : "assistant", db, {
      items: payment.items,
      paymentMethod: "paypal",
      paymentRef: capture.captureId,
      clearCart: payment.fromCart,
    }).id;
  } catch (error) {
    // The sandbox payment went through but the order couldn't be placed
    // (for example an item sold out meanwhile). A real store would refund here.
    console.error("Order after PayPal capture failed", paypalOrderId, error);
    throw fail(
      `Your PayPal sandbox payment went through, but the order couldn't be placed: ${
        error instanceof StoreError ? error.message : "please contact support"
      }`,
    );
  }
  db.update(paypalPayments)
    .set({ status: "completed", orderId })
    .where(eq(paypalPayments.paypalOrderId, paypalOrderId))
    .run();
  return { orderId, placedVia: payment.placedVia, returnPath: payment.returnPath };
}

/** The shopper backed out on PayPal. Returns where to send them. */
export function cancelPayPalPayment(sessionId: string, paypalOrderId: string, db: DB = getDb()) {
  const payment = findPayment(sessionId, paypalOrderId, db);
  if (!payment) return "/";
  if (payment.status === "created") {
    db.update(paypalPayments).set({ status: "cancelled" }).where(eq(paypalPayments.paypalOrderId, paypalOrderId)).run();
  }
  return payment.returnPath;
}
