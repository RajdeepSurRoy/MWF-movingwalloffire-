import { z } from "zod";
import type { ChatCompletionFunctionTool } from "openai/resources/chat/completions";
import type { DB } from "../db";
import { getDb } from "../db";
import type { Product } from "../db/schema";
import { DELIVERY_SLOTS, MAX_QTY_PER_ITEM } from "../catalog";
import { formatPrice } from "../pricing";
import {
  PAYMENT_LABELS,
  PAYMENT_METHODS,
  addToCart,
  friendlyError,
  getCart,
  getProduct,
  listOrders,
  setCartQuantity,
  type Cart,
} from "../store";
import { FIELD_LABELS, confirmCheckout, updateCheckout, type CheckoutCardData, type PlacedOrder } from "./checkout";

// ---------- What the model sees ----------
// The catalog and the cart are already in the system prompt, so there are no
// search or view-cart tools: every tool call is a round trip to the API, and
// the free tier counts each one against its per-minute limit.

const itemsParam = (min: number) => ({
  type: "array",
  description: "One entry per product.",
  items: {
    type: "object",
    properties: {
      sku: { type: "string", description: "SKU from the catalog" },
      quantity: { type: "integer", minimum: min, maximum: MAX_QTY_PER_ITEM },
    },
    required: ["sku", "quantity"],
  },
});

export const TOOL_DEFINITIONS: ChatCompletionFunctionTool[] = [
  {
    type: "function",
    function: {
      name: "add_to_cart",
      description: `Add one or more products to the cart in a single call (adds to existing quantities). Max ${MAX_QTY_PER_ITEM} per item.`,
      parameters: { type: "object", properties: { items: itemsParam(1) }, required: ["items"] },
    },
  },
  {
    type: "function",
    function: {
      name: "update_cart",
      description: "Set exact quantities for products in the cart in a single call. Quantity 0 removes the item.",
      parameters: { type: "object", properties: { items: itemsParam(0) }, required: ["items"] },
    },
  },
  {
    type: "function",
    function: {
      name: "checkout",
      description:
        "Start or update the checkout. Pass `items` to buy specific products right now (\"buy this\") without touching the cart; omit `items` to check out the cart. Also pass any delivery details or payment choice the shopper gave. The shopper sees an order summary and is asked to confirm.",
      parameters: {
        type: "object",
        properties: {
          items: itemsParam(1),
          use_cart: { type: "boolean", description: "true to switch to checking out the whole cart" },
          name: { type: "string", description: "Full name" },
          email: { type: "string" },
          address: { type: "string", description: "Full delivery address" },
          delivery_slot: { type: "string", enum: [...DELIVERY_SLOTS] },
          payment_method: {
            type: "string",
            enum: [...PAYMENT_METHODS],
            description:
              "card = demo card, paid instantly; paypal = PayPal sandbox (a linked account is charged instantly, otherwise the shopper approves once on PayPal); cash_on_delivery",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "confirm_order",
      description:
        "Place and pay for the current checkout, right away. ONLY call this when the shopper's latest message clearly says yes to the order summary and total they were shown.",
      parameters: {
        type: "object",
        properties: { payment_method: { type: "string", enum: [...PAYMENT_METHODS] } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_product",
      description: "Full description of one product. Only needed for detailed questions the catalog line doesn't answer.",
      parameters: { type: "object", properties: { sku: { type: "string" } }, required: ["sku"] },
    },
  },
  {
    type: "function",
    function: {
      name: "list_orders",
      description: "The shopper's recent orders and their status.",
      parameters: { type: "object", properties: {} },
    },
  },
];

// ---------- Argument validation (never trust model output) ----------

const sku = z.string().trim().min(3).max(40);
const items = (min: number) =>
  z.array(z.object({ sku, quantity: z.number().int().min(min).max(MAX_QTY_PER_ITEM) })).min(1).max(20);
const argSchemas = {
  add_to_cart: z.object({ items: items(1) }),
  update_cart: z.object({ items: items(0) }),
  checkout: z.object({
    items: items(1).optional(),
    use_cart: z.boolean().optional(),
    name: z.string().optional(),
    email: z.string().optional(),
    address: z.string().optional(),
    delivery_slot: z.string().optional(),
    payment_method: z.enum(PAYMENT_METHODS).optional(),
  }),
  confirm_order: z.object({ payment_method: z.enum(PAYMENT_METHODS).optional() }),
  get_product: z.object({ sku }),
  list_orders: z.object({}),
} as const;

export type ToolName = keyof typeof argSchemas;

/**
 * Tools whose result the server can describe itself. When every call in a
 * round is one of these and none failed, the reply is written from the result
 * and the second API call (asking the model to summarise) is skipped.
 */
const ACTION_TOOLS = new Set<ToolName>(["add_to_cart", "update_cart", "checkout", "confirm_order"]);

// ---------- What the chat widget gets ----------

export type ProductCardData = {
  sku: string;
  name: string;
  brand: string;
  unit: string;
  priceCents: number;
  stock: number;
  image: Product["image"];
};

export type ToolEffects = {
  products?: ProductCardData[];
  cartChanged?: boolean;
  checkout?: CheckoutCardData;
  order?: PlacedOrder;
  /** PayPal's approval page for the current checkout. */
  paypal?: { approveUrl: string; amountCents: number };
};

export type ToolOutcome = {
  output: unknown;
  effects: ToolEffects;
  /** A ready-to-show reply when this was a successful action. */
  reply?: string;
};

export function card(p: Product): ProductCardData {
  return { sku: p.sku, name: p.name, brand: p.brand, unit: p.unit, priceCents: p.priceCents, stock: p.stock, image: p.image };
}

export function cartForModel(cart: Cart) {
  if (cart.lines.length === 0) return "empty";
  const lines = cart.lines.map((l) => `${l.quantity} × ${l.name} [${l.sku}] = ${formatPrice(l.lineTotalCents)}`);
  const delivery = cart.totals.deliveryCents ? formatPrice(cart.totals.deliveryCents) : "free";
  return `${lines.join("; ")}. Subtotal ${formatPrice(cart.totals.subtotalCents)}, delivery ${delivery}, total ${formatPrice(cart.totals.totalCents)}.`;
}

export function checkoutForModel(c: CheckoutCardData) {
  return {
    checkout_id: c.id,
    buying: c.source === "cart" ? "the cart" : "buy-now items only",
    items: c.items.map((i) => `${i.quantity} × ${i.name}`),
    total: formatPrice(c.totals.totalCents),
    delivery_fee: c.totals.deliveryCents ? formatPrice(c.totals.deliveryCents) : "free",
    details: c.details,
    still_needed: c.missing.map((f) => FIELD_LABELS[f]),
    payment: c.paymentMethod === "paypal" && c.paypalLinked ? `PayPal account ${c.paypalLinked} (linked, charged instantly)` : PAYMENT_LABELS[c.paymentMethod],
  };
}

function paymentPhrase(c: CheckoutCardData) {
  if (c.paymentMethod === "card") return "paid with the demo card";
  if (c.paymentMethod === "cash_on_delivery") return "paid on delivery";
  return c.paypalLinked
    ? `paid with your PayPal (${c.paypalLinked})`
    : "paid with PayPal (you approve it on PayPal once, which links your account for next time)";
}

function listNames(names: string[]) {
  return names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

export function checkoutReply(c: CheckoutCardData) {
  const total = formatPrice(c.totals.totalCents);
  if (c.missing.length) {
    return `Your order comes to ${total}. To deliver it I just need your ${listNames(c.missing.map((f) => FIELD_LABELS[f]))}: just type ${c.missing.length === 1 ? "it" : "them"} here.`;
  }
  const what = c.items.length === 1 ? `${c.items[0].quantity} × ${c.items[0].name}` : `${c.totals.itemCount} items`;
  return `Ready to order: ${what} for ${total}, ${paymentPhrase(c)}, arriving ${c.details.deliverySlot!.toLowerCase()} at ${c.details.address}. Shall I place it?`;
}

export function paypalReply(amountCents: number) {
  return `Opening PayPal so you can approve ${formatPrice(amountCents)} with your sandbox test account. This is a one-time step: it links your PayPal, so next time I can pay as soon as you say yes.`;
}

export function orderReply(o: PlacedOrder) {
  const total = formatPrice(o.totalCents);
  const paid =
    o.paymentMethod === "card"
      ? `paid ${total} with the demo card`
      : o.paymentMethod === "paypal"
        ? `paid ${total} with your PayPal`
        : `${total} to pay on delivery`;
  return `Done! Order ${o.id} is placed (${paid}). It arrives ${o.deliverySlot.toLowerCase()}.`;
}

/**
 * Runs one tool call for one shopper session. Errors come back as
 * `{ error }` so the model can explain them, instead of crashing the chat.
 */
export function runTool(sessionId: string, name: string, rawArgs: string, db: DB = getDb()): ToolOutcome {
  if (!(name in argSchemas)) return { output: { error: `Unknown tool ${name}` }, effects: {} };
  let args: unknown;
  try {
    args = rawArgs ? JSON.parse(rawArgs) : {};
  } catch {
    return { output: { error: "Tool arguments were not valid JSON." }, effects: {} };
  }
  const parsed = argSchemas[name as ToolName].safeParse(args);
  if (!parsed.success) {
    return { output: { error: parsed.error.issues[0]?.message ?? "Invalid arguments." }, effects: {} };
  }

  try {
    switch (name as ToolName) {
      case "add_to_cart": {
        const a = parsed.data as z.infer<typeof argSchemas.add_to_cart>;
        // Each item is applied on its own, so one bad SKU doesn't block the rest.
        const added: string[] = [];
        const failed: string[] = [];
        for (const item of a.items) {
          try {
            addToCart(sessionId, item.sku, item.quantity, db);
            added.push(`${item.quantity} × ${getProduct(item.sku, db)?.name ?? item.sku}`);
          } catch (error) {
            failed.push(`${item.sku}: ${friendlyError(error)}`);
          }
        }
        const cart = getCart(sessionId, db);
        if (failed.length) return { output: { added, failed, cart: cartForModel(cart) }, effects: { cartChanged: added.length > 0 } };
        return {
          output: { ok: true, added, cart: cartForModel(cart) },
          effects: { cartChanged: true },
          reply: `Added ${listNames(added)}. Your cart is now ${formatPrice(cart.totals.totalCents)}${
            cart.totals.deliveryCents ? "" : " with free delivery"
          }. Want to check out?`,
        };
      }
      case "update_cart": {
        const a = parsed.data as z.infer<typeof argSchemas.update_cart>;
        for (const item of a.items) setCartQuantity(sessionId, item.sku, item.quantity, db);
        const cart = getCart(sessionId, db);
        return {
          output: { ok: true, cart: cartForModel(cart) },
          effects: { cartChanged: true },
          reply: cart.lines.length ? `Updated. Your cart is now ${formatPrice(cart.totals.totalCents)}.` : "Done, your cart is empty now.",
        };
      }
      case "checkout": {
        const a = parsed.data as z.infer<typeof argSchemas.checkout>;
        const checkout = updateCheckout(
          sessionId,
          {
            items: a.items,
            useCart: a.use_cart,
            name: a.name,
            email: a.email,
            address: a.address,
            deliverySlot: a.delivery_slot,
            paymentMethod: a.payment_method,
          },
          db,
        );
        return { output: checkoutForModel(checkout), effects: { checkout }, reply: checkoutReply(checkout) };
      }
      case "confirm_order": {
        const a = parsed.data as z.infer<typeof argSchemas.confirm_order>;
        const order = confirmCheckout(sessionId, { paymentMethod: a.payment_method }, db);
        return {
          output: { ok: true, order_id: order.id, total: formatPrice(order.totalCents), payment: PAYMENT_LABELS[order.paymentMethod] },
          effects: { cartChanged: true, order },
          reply: orderReply(order),
        };
      }
      case "get_product": {
        const { sku } = parsed.data as z.infer<typeof argSchemas.get_product>;
        const p = getProduct(sku, db);
        if (!p) return { output: { error: `No product with SKU ${sku}.` }, effects: {} };
        return {
          output: { sku: p.sku, name: p.name, price: formatPrice(p.priceCents), description: p.description, in_stock: p.stock },
          effects: { products: [card(p)] },
        };
      }
      case "list_orders": {
        const orders = listOrders(sessionId, db).slice(0, 5);
        return {
          output: {
            orders: orders.map((o) => ({
              id: o.id,
              status: o.status,
              total: formatPrice(o.totalCents),
              payment: o.paymentStatus === "paid" ? "paid" : "pay on delivery",
              delivery_slot: o.deliverySlot,
              items: o.items.map((i) => `${i.quantity} × ${i.name}`),
            })),
          },
          effects: {},
        };
      }
    }
  } catch (error) {
    return { output: { error: friendlyError(error) }, effects: {} };
  }
  return { output: { error: "Unhandled tool." }, effects: {} };
}

export function isActionTool(name: string) {
  return ACTION_TOOLS.has(name as ToolName);
}

export function mergeEffects(into: ToolEffects, next: ToolEffects): ToolEffects {
  return {
    products: next.products ?? into.products,
    cartChanged: into.cartChanged || next.cartChanged,
    checkout: next.order ? undefined : (next.checkout ?? into.checkout),
    order: next.order ?? into.order,
    paypal: next.paypal ?? into.paypal,
  };
}
