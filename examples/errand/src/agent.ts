import type {
  ChatCompletionFunctionTool,
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
} from "openai/resources/chat/completions";
import OpenAI from "openai";
import { z } from "zod";
import { config } from "./config.js";
import { resetBrowser, snapshot } from "./browser.js";
import { emit, newId, say, setStatus, step, type PaymentRequest, type ProductCard } from "./events.js";
import { complete, NoApiKeyError, QuotaExhaustedError, RateLimitedError } from "./llm.js";
import { recordSaved } from "./usage.js";
import { getProfile } from "./profile.js";
import * as store from "./store.js";
import * as firewall from "./firewall.js";

// ---------- Tools the model can call ----------

const itemsSchema = z
  .array(z.object({ sku: z.string().trim().min(3).max(40), quantity: z.number().int().min(0).max(20) }))
  .min(1)
  .max(15);

const toolInputs = {
  search_store: z.object({ queries: z.array(z.string().trim().min(1).max(60)).min(1).max(6) }),
  browse_aisle: z.object({ categories: z.array(z.enum(store.CATEGORIES)).min(1).max(4) }),
  view_product: z.object({ sku: z.string().trim().min(3).max(40) }),
  add_to_cart: z.object({ items: itemsSchema }),
  update_cart: z.object({ items: itemsSchema }),
  view_cart: z.object({}),
  suggest_products: z.object({
    message: z.string().trim().min(1).max(800),
    items: z.array(z.object({ sku: z.string().trim(), reason: z.string().trim().max(140).optional() })).min(1).max(8),
  }),
  request_payment: z.object({
    name: z.string().trim().optional(),
    email: z.string().trim().optional(),
    address: z.string().trim().optional(),
    deliverySlot: z.enum(store.DELIVERY_SLOTS).optional(),
  }),
  list_orders: z.object({}),
};
type ToolName = keyof typeof toolInputs;

const itemsJson = {
  type: "array",
  items: {
    type: "object",
    properties: {
      sku: { type: "string", description: "Item code from the website, e.g. PRD-APPLE-2LB" },
      quantity: { type: "integer", minimum: 0, maximum: 20 },
    },
    required: ["sku", "quantity"],
  },
};

const TOOLS: ChatCompletionFunctionTool[] = [
  {
    type: "function",
    function: {
      name: "search_store",
      description:
        "Search the FreshCart website. Pass several short queries at once (e.g. a whole recipe's ingredients) to save steps. Returns the product cards shown on each results page.",
      parameters: {
        type: "object",
        properties: { queries: { type: "array", items: { type: "string" }, description: "1 to 6 short search terms, like 'pasta' or 'tomato sauce'" } },
        required: ["queries"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browse_aisle",
      description:
        "Open one or more aisles (category pages) of the website and list every product in them. Pass all the aisles you need in one call.",
      parameters: {
        type: "object",
        properties: {
          categories: { type: "array", items: { type: "string", enum: [...store.CATEGORIES] }, description: "1 to 4 aisles" },
        },
        required: ["categories"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "view_product",
      description: "Open a product page to read its full description and stock. Only when the user needs details.",
      parameters: { type: "object", properties: { sku: { type: "string" } }, required: ["sku"] },
    },
  },
  {
    type: "function",
    function: {
      name: "add_to_cart",
      description: "Add items to the cart on the website. Quantities add to what is already in the cart.",
      parameters: { type: "object", properties: { items: itemsJson }, required: ["items"] },
    },
  },
  {
    type: "function",
    function: {
      name: "update_cart",
      description: "Set exact quantities of items in the cart. Quantity 0 removes the item.",
      parameters: { type: "object", properties: { items: itemsJson }, required: ["items"] },
    },
  },
  {
    type: "function",
    function: {
      name: "view_cart",
      description: "Open the cart page and read the items and total.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "suggest_products",
      description:
        "Show the user product suggestions as cards in the chat, with your message. Use only SKUs you have seen on the website in this conversation. This ends your turn.",
      parameters: {
        type: "object",
        properties: {
          message: { type: "string", description: "Your short reply to the user, shown above the cards" },
          items: {
            type: "array",
            items: {
              type: "object",
              properties: { sku: { type: "string" }, reason: { type: "string", description: "Why it fits, a few words" } },
              required: ["sku"],
            },
          },
        },
        required: ["message", "items"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "request_payment",
      description:
        "Fill in the website's checkout form with the delivery details and read the final total, then ask the user to approve the payment. Leave a field out to use the user's saved profile. The order is NOT placed until the user approves. This ends your turn.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          email: { type: "string" },
          address: { type: "string" },
          deliverySlot: { type: "string", enum: [...store.DELIVERY_SLOTS] },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_orders",
      description: "Open the order history page on the website.",
      parameters: { type: "object", properties: {} },
    },
  },
];

const TOOL_LABELS: Record<ToolName, string> = {
  search_store: "Searching the store",
  browse_aisle: "Browsing an aisle",
  view_product: "Reading a product page",
  add_to_cart: "Adding to cart",
  update_cart: "Updating the cart",
  view_cart: "Checking the cart",
  suggest_products: "Picking suggestions",
  request_payment: "Filling in checkout",
  list_orders: "Checking past orders",
};

// ---------- System prompt ----------

/** The catalog the agent read from the aisles, one short line per product, grouped by aisle. */
function catalogText(items: store.CatalogItem[]) {
  return store.CATEGORIES.map((aisle) => {
    const lines = items
      .filter((i) => i.aisle === aisle)
      .map((i) => `${i.sku} | ${i.name} | ${i.unit} | ${i.price}${i.soldOut ? " | SOLD OUT" : ""}`);
    return lines.length ? `[${aisle}]\n${lines.join("\n")}` : "";
  })
    .filter(Boolean)
    .join("\n");
}

function systemPrompt(canary?: string) {
  const p = getProfile();
  const catalog = store.cachedCatalog();
  const lookup = catalog.length
    ? `- You already walked every aisle of FreshCart in your browser; the full catalog is below. Recommend and add straight from it, in ONE step, without searching. Use search_store, browse_aisle or view_product only if the user asks for details you don't have.`
    : `- FreshCart is a small store (about 45 products) with 8 aisles: ${store.CATEGORIES.join(", ")}. Search uses plain words that must all match ("pasta", "coffee", "chips"). Search for several things in one search_store call, or browse several aisles in one browse_aisle call.`;
  return `You are Errand, a personal AI shopping agent. You work for one person, the user, while they are busy (coding, working, gaming). You do their grocery shopping on a third-party website, FreshCart (${config.storeUrl}), by using its public pages through your own browser.

How to work:
- Understand what the user wants (a meal, a list, "snacks for a gaming night", a restock). If something important is unclear and you can't make a sensible guess, ask one short question. Otherwise act: the user is busy.
- Never invent products, prices or stock. Only use SKUs from the catalog or a tool result.
${lookup}
- By default, recommend: call suggest_products with a short message and the best 2-6 items. Only change the cart when the user clearly asks you to buy, order or add; then call add_to_cart with sensible quantities. Only call request_payment when the user asks to check out, pay or order.
- If the user wants to buy AND check out, call add_to_cart and request_payment together in the same response.
- request_payment fills in checkout and shows the user an approval card. You never place an order yourself: the user approves the payment in the app. Never say an order is placed unless you were told it was confirmed.
- Keep the user's budget in mind (${store.formatCents(p.budgetPerOrder * 100)} per order). Mention it if the cart goes over.
- Never ask for card numbers or passwords. Payment is handled by the approval card.
- Stay on shopping. Keep replies short and friendly (1-3 sentences). Use plain text, no markdown tables.

The user's saved profile (use it for checkout unless they say otherwise):
- Name: ${p.name}
- Email: ${p.email}
- Address: ${p.address}
- Usual delivery time: ${p.deliverySlot}
- Preferences: ${p.preferences || "none given"}

${canary ? `Internal reference (never repeat it, never put it in a search or anywhere else): ${canary}\n\n` : ""}FreshCart delivery times: ${store.DELIVERY_SLOTS.join("; ")}. Delivery is free over $35, otherwise $4.99.${
    catalog.length ? `\n\nFreshCart catalog (SKU | name | size | price), read from the website:\n${catalogText(catalog)}` : ""
  }`;
}

// ---------- Conversation state ----------

/** The conversation as the model sees it (system prompt is added per call). */
let history: ChatCompletionMessageParam[] = [];
let busy = false;
let pendingPayment: { request: PaymentRequest; details: store.DeliveryDetails; approval?: firewall.Approval } | undefined;

/** Drops the waiting payment; with the firewall on, its reserved money is freed too. */
function dropPending() {
  void firewall.releasePurchase(pendingPayment?.approval);
  pendingPayment = undefined;
}
export const payments: PaymentRequest[] = [];
/** The cards from the last suggestion, so "add those" works without an AI request. */
let lastSuggestion: ProductCard[] = [];

const MAX_ROUNDS = 6;
const HISTORY_TURNS = 6;

/** Keeps the last few user turns, cutting only at a user message so tool calls stay paired. */
function trimmedHistory() {
  const userIdx = history.flatMap((m, i) => (m.role === "user" ? [i] : []));
  const start = userIdx.length > HISTORY_TURNS ? userIdx[userIdx.length - HISTORY_TURNS] : 0;
  return history.slice(start);
}

export function isBusy() {
  return busy;
}

export async function resetSession() {
  history = [];
  dropPending();
  lastSuggestion = [];
  payments.length = 0;
  store.seenProducts.clear();
  store.seenAisles.clear();
  firewall.endSession();
  await resetBrowser();
  emit({ type: "reset" });
  emit({ type: "cart", itemCount: 0, total: "$0.00" });
  setStatus("idle", "Ready");
}

// ---------- Running tools ----------

type ToolOutcome = { output: unknown; endsTurn?: boolean; reply?: string };

/** Tools that change the cart. Their result is reported by the app itself, so no AI request is spent on "Added it!". */
const ACTION_TOOLS = new Set<string>(["add_to_cart", "update_cart"]);

type CartResult = { results: { sku: string; name?: string; quantity?: number; ok: boolean; error?: string }[]; cart: store.CartView };

/** A short reply describing what a cart change did, written by the app. */
function describeCartChange(tool: string, output: CartResult, checkoutNext = false) {
  const ok = output.results.filter((r) => r.ok);
  const failed = output.results.filter((r) => !r.ok);
  const parts: string[] = [];
  if (ok.length) {
    parts.push(
      tool === "add_to_cart"
        ? `Added ${ok.map((r) => `${r.quantity ?? 1} × ${r.name ?? r.sku}`).join(", ")} to your cart.`
        : "Updated your cart.",
    );
  }
  for (const f of failed) parts.push(`Couldn't change ${f.name ?? f.sku}: ${f.error}.`);
  parts.push(
    output.cart.lines.length
      ? `Cart total: ${output.cart.total} (${output.cart.itemCount} items).${checkoutNext ? "" : ` Say "check out" when you're ready.`}`
      : "Your cart is empty.",
  );
  const budget = getProfile().budgetPerOrder * 100;
  if (store.toCents(output.cart.total) > budget) parts.push(`That's over your ${store.formatCents(budget)} budget.`);
  return parts.join(" ");
}

async function runTool(name: string, rawArgs: string): Promise<ToolOutcome> {
  if (!(name in toolInputs)) return { output: { error: `Unknown tool ${name}` } };
  const tool = name as ToolName;
  let args: unknown;
  try {
    args = toolInputs[tool].parse(JSON.parse(rawArgs || "{}"));
  } catch (error) {
    const message = error instanceof z.ZodError ? error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : "Arguments were not valid JSON";
    return { output: { error: `Invalid input: ${message}` } };
  }
  setStatus(tool === "suggest_products" ? "thinking" : "browsing", TOOL_LABELS[tool]);
  try {
    switch (tool) {
      case "search_store": {
        const { queries } = args as z.infer<typeof toolInputs.search_store>;
        const results: Record<string, unknown> = {};
        for (const q of queries) results[q] = (await store.search(q)).map(compact);
        return { output: results };
      }
      case "browse_aisle": {
        const { categories } = args as z.infer<typeof toolInputs.browse_aisle>;
        const results: Record<string, unknown> = {};
        for (const c of categories) results[c] = (await store.browseCategory(c)).map(compact);
        return { output: results };
      }
      case "view_product":
        return { output: await store.viewProduct((args as { sku: string }).sku) };
      case "add_to_cart":
        return { output: await store.addToCart((args as z.infer<typeof toolInputs.add_to_cart>).items) };
      case "update_cart":
        return { output: await store.updateCart((args as z.infer<typeof toolInputs.update_cart>).items) };
      case "view_cart":
        return { output: await store.viewCart() };
      case "list_orders":
        return { output: await store.listOrders() };
      case "suggest_products": {
        const { message, items } = args as z.infer<typeof toolInputs.suggest_products>;
        const products: ProductCard[] = items.flatMap((i) => {
          const seen = store.findSeenProduct(i.sku);
          return seen ? [{ ...seen, reason: i.reason }] : [];
        });
        const unknown = items.filter((i) => !store.findSeenProduct(i.sku)).map((i) => i.sku);
        if (products.length === 0) {
          return { output: { error: `None of these SKUs were seen on the website: ${unknown.join(", ")}. Search first.` } };
        }
        say({ role: "agent", text: await firewall.checkReply(message), products });
        lastSuggestion = products;
        return { output: { shown: products.map((p) => p.sku), ignoredUnknownSkus: unknown }, endsTurn: true, reply: message };
      }
      case "request_payment":
        return await requestPayment(args as z.infer<typeof toolInputs.request_payment>);
    }
  } catch (error) {
    if (error instanceof store.StoreError || error instanceof firewall.FirewallStop) return { output: { error: error.message } };
    console.error(error);
    step("error", "Browser step failed", error instanceof Error ? error.message.split("\n")[0] : String(error))("failed");
    await snapshot();
    return { output: { error: "The browser step failed. The page may have changed; try again or another way." } };
  }
}

function compact(p: ProductCard) {
  return { sku: p.sku, name: p.name, brand: p.brand, unit: p.unit, price: p.price, ...(p.soldOut ? { soldOut: true } : {}) };
}

async function requestPayment(input: z.infer<typeof toolInputs.request_payment>): Promise<ToolOutcome> {
  const profile = getProfile();
  const details: store.DeliveryDetails = {
    name: input.name || profile.name,
    email: input.email || profile.email,
    address: input.address || profile.address,
    deliverySlot: input.deliverySlot || profile.deliverySlot,
  };
  let checkout: Awaited<ReturnType<typeof store.prepareCheckout>>;
  let approval: firewall.Approval | undefined;
  if (firewall.firewallOn()) {
    const read = await store.readPurchase(details);
    checkout = read.checkout;
    if (pendingPayment) dropPending();
    // Throws FirewallStop unless the firewall allows it: then the user never sees a card.
    approval = await firewall.checkPurchase(read.purchase);
  } else {
    checkout = await store.prepareCheckout(details);
  }
  if (pendingPayment) pendingPayment.request.status = "declined";
  const request: PaymentRequest = {
    id: newId(),
    merchant: store.MERCHANT,
    lines: checkout.lines,
    subtotal: checkout.subtotal,
    delivery: checkout.delivery,
    total: checkout.total,
    totalCents: checkout.totalCents,
    deliverTo: details,
    method: checkout.payWith.label,
    status: "pending",
    ...(firewall.reviewWarning(approval) && { warning: firewall.reviewWarning(approval) }),
  };
  pendingPayment = { request, details, approval };
  const overBudget = checkout.totalCents > profile.budgetPerOrder * 100;
  say({
    role: "agent",
    text: `${request.warning ? `${request.warning}\n\n` : ""}Checkout is filled in on FreshCart. The total is ${checkout.total}${overBudget ? `, which is over your ${store.formatCents(profile.budgetPerOrder * 100)} budget` : ""}. ${
      checkout.payWith.kind === "paypal"
        ? "Confirm (or just say yes) and I'll pay with my PayPal wallet and place the order myself."
        : "Confirm (or just say yes) and I'll place the order."
    }`,
    payment: request,
  });
  setStatus("awaiting_approval", "Waiting for your approval");
  return {
    output: { status: "awaiting_user_approval", total: checkout.total, lines: checkout.lines },
    endsTurn: true,
    reply: `I filled in checkout (total ${checkout.total}) and asked you to approve the payment.`,
  };
}

// ---------- Payment approval (done by the user in the app, no AI involved) ----------

export async function approvePayment(id: string) {
  if (busy) throw new Error("The agent is busy. Try again in a moment.");
  if (!pendingPayment || pendingPayment.request.id !== id) {
    throw new Error("This payment request is no longer active.");
  }
  const { request, details, approval } = pendingPayment;
  pendingPayment = undefined;
  busy = true;
  setStatus("paying", request.method.startsWith("PayPal") ? "Paying with PayPal" : "Placing your order");
  const auth = step("pay", "Payment approved by you", `${request.total} to ${request.merchant}`);
  auth();
  try {
    let commit: store.CommitHook | undefined;
    // The user's click on the card is the approval of a payment the firewall held.
    if (approval?.review) await firewall.approveReview(approval);
    if (approval) {
      // What the shop shows now must be exactly what the user approved. The commit itself runs
      // inside placeOrder, right before the irreversible click, with what PayPal holds if it pays.
      const live = await store.readPurchase(details);
      commit = (prepared) => firewall.commitPurchase(approval, live.purchase, prepared);
    }
    const order = await store.placeOrder(details, request.totalCents, commit);
    request.status = "approved";
    payments.unshift(request);
    emit({ type: "message", message: { id: newId(), role: "system", text: "", payment: request, at: Date.now() } });
    say({
      role: "agent",
      text: `Done! ${order.payWith.kind === "paypal" ? `I paid ${order.total} with PayPal and order` : "Order"} ${order.orderId} is placed on FreshCart. It arrives ${details.deliverySlot.toLowerCase()}.`,
      order: {
        orderId: order.orderId,
        merchant: request.merchant,
        total: order.total,
        deliverySlot: details.deliverySlot,
        url: order.url,
        payment: order.payWith.label,
        paypalOrderId: order.paypalOrderId,
      },
    });
    history.push({ role: "user", content: `[App] I approved the payment of ${request.total}.` });
    history.push({
      role: "assistant",
      content: `The order was placed and confirmed by FreshCart: order ${order.orderId}, total ${order.total}, delivery ${details.deliverySlot}. The cart is now empty.`,
    });
  } catch (error) {
    request.status = "failed";
    const known = error instanceof store.StoreError || error instanceof firewall.FirewallStop;
    const message = known ? error.message : "Something went wrong while placing the order.";
    if (!known) console.error(error);
    void firewall.releasePurchase(approval);
    step("error", "Order not placed", message)("failed");
    say({ role: "agent", text: `I couldn't place the order: ${message}` });
    history.push({ role: "user", content: `[App] I approved the payment of ${request.total}.` });
    history.push({ role: "assistant", content: `Placing the order failed: ${message}` });
  } finally {
    busy = false;
    setStatus("idle", "Ready");
  }
}

export function declinePayment(id: string) {
  if (!pendingPayment || pendingPayment.request.id !== id) throw new Error("This payment request is no longer active.");
  pendingPayment.request.status = "declined";
  emit({ type: "message", message: { id: newId(), role: "system", text: "", payment: pendingPayment.request, at: Date.now() } });
  dropPending();
  step("pay", "Payment declined by you")();
  say({ role: "agent", text: "No problem, I didn't place the order. Your cart is still there if you want to change anything." });
  history.push({ role: "user", content: "[App] I declined the payment." });
  history.push({ role: "assistant", content: "Payment declined, the order was not placed. The cart is unchanged." });
  setStatus("idle", "Ready");
}

/** The chat's "Add" button on a product card: adds one straight away, without an AI request. */
export async function quickAdd(sku: string) {
  if (busy) throw new Error("The agent is busy. Try again in a moment.");
  busy = true;
  setStatus("browsing", "Adding to cart");
  try {
    const { results, cart } = await store.addToCart([{ sku, quantity: 1 }]);
    const r = results[0];
    const text = r?.ok ? `Added ${r.name} to your cart. Cart total: ${cart.total}.` : `I couldn't add that: ${r?.error ?? "unknown error"}`;
    say({ role: "agent", text });
    history.push({ role: "user", content: `[App] I tapped Add on ${sku}.` });
    history.push({ role: "assistant", content: text });
  } finally {
    busy = false;
    setStatus("idle", "Ready");
  }
}

const YES = /^\s*(yes|yep|yeah|y|ok|okay|sure|approve|approved|confirm|pay|go ahead|do it|place it|place the order)\b[\s.!]*$/i;
const NO = /^\s*(no|nope|cancel|decline|stop|don'?t)\b[\s.!]*$/i;

// ---------- Shortcuts: common requests handled by the app, with no AI request ----------

const NUMBERS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
const LEAD = String.raw`(?:(?:ok(?:ay)?|yes|yeah|great|cool|nice|perfect|sure)[,!.]?\s+)?(?:please\s+|pls\s+)?`;
const CHECKOUT = String.raw`(?:check ?out|pay|place (?:the |my )?order|order (?:it|them|now)|buy (?:it|now)|(?:go|proceed) to checkout)`;
const SHORTCUTS = {
  cart: /^(?:what'?s|what is)? ?(?:in )?(?:my |the )?cart$|^(?:show|view|check|see|open)(?: me)? (?:my |the )?cart$/,
  orders: /^(?:show|list|view|check|see)?(?: me)? ?(?:my |past |recent |previous )*orders$/,
  addSuggested: new RegExp(
    String.raw`^${LEAD}(?:add|buy|get|order)\s+(those|them|these|it|that|everything|all(?: of (?:them|those|these))?|the first (\w+)|the first one)(?: to (?:my |the )?cart)?(?:\s*(?:,|and|&|then|and then)\s*(${CHECKOUT}))?(?: please)?$`,
  ),
  checkout: new RegExp(String.raw`^${LEAD}${CHECKOUT}(?: please| now)?$`),
};

/** Recognises short, common requests and does them directly. Returns true if handled. */
async function tryShortcut(text: string): Promise<boolean> {
  const t = text.trim().toLowerCase().replace(/[.!?]+$/, "").replace(/\s+/g, " ");
  if (t.length > 80) return false;

  if (SHORTCUTS.cart.test(t)) {
    setStatus("browsing", "Checking the cart");
    const cart = await store.viewCart();
    const reply = cart.lines.length
      ? `Your cart: ${cart.lines.map((l) => `${l.quantity} × ${l.name} (${l.total})`).join(", ")}. Total ${cart.total}.`
      : "Your cart is empty.";
    return finishShortcut(reply);
  }

  if (SHORTCUTS.orders.test(t)) {
    setStatus("browsing", "Checking past orders");
    const orders = await store.listOrders();
    const reply = orders.length
      ? `Your FreshCart orders: ${orders.slice(0, 5).map((o) => o.summary).join("; ")}.`
      : "You haven't placed any FreshCart orders through me yet.";
    return finishShortcut(reply);
  }

  const add = SHORTCUTS.addSuggested.exec(t);
  if (add && lastSuggestion.length) {
    const count = add[1] === "the first one" ? 1 : add[2] ? (NUMBERS[add[2]] ?? Number(add[2])) : lastSuggestion.length;
    if (!Number.isInteger(count) || count < 1) return false;
    const picks = lastSuggestion.filter((p) => !p.soldOut).slice(0, count);
    setStatus("browsing", "Adding to cart");
    const result = await store.addToCart(picks.map((p) => ({ sku: p.sku, quantity: 1 })));
    const reply = describeCartChange("add_to_cart", result, !!add[3]);
    if (!add[3]) return finishShortcut(reply);
    say({ role: "agent", text: reply });
    history.push({ role: "assistant", content: reply });
    return checkoutShortcut();
  }

  if (SHORTCUTS.checkout.test(t)) return checkoutShortcut();
  return false;
}

async function checkoutShortcut() {
  setStatus("browsing", "Filling in checkout");
  try {
    const outcome = await requestPayment({});
    history.push({ role: "assistant", content: outcome.reply ?? "" });
    recordSaved("shortcut");
  } catch (error) {
    if (!(error instanceof store.StoreError)) throw error;
    finishShortcut(error.message);
  }
  return true;
}

function finishShortcut(reply: string) {
  say({ role: "agent", text: reply });
  history.push({ role: "assistant", content: reply });
  recordSaved("shortcut");
  return true;
}

// ---------- One user turn ----------

export async function handleUserMessage(text: string) {
  if (busy) throw new Error("The agent is still working on your last request.");
  say({ role: "user", text });

  // A plain yes/no to a waiting payment is answered here, without an AI request.
  if (pendingPayment && YES.test(text)) return approvePayment(pendingPayment.request.id);
  if (pendingPayment && NO.test(text)) return declinePayment(pendingPayment.request.id);

  // Anything else replaces the waiting payment: the cart may change, so a new approval is needed.
  if (pendingPayment) {
    pendingPayment.request.status = "declined";
    emit({ type: "message", message: { id: newId(), role: "system", text: "", payment: pendingPayment.request, at: Date.now() } });
    dropPending();
    history.push({ role: "user", content: "[App] The payment request was cancelled because I asked for something else." });
    history.push({ role: "assistant", content: "Understood, that payment request is cancelled. I'll ask for a new approval before paying." });
  }

  busy = true;
  firewall.setTask(text);
  history.push({ role: "user", content: text });
  try {
    if (await tryShortcut(text)) return;
    if (config.prefetchCatalog || config.llmMode !== "gemini") {
      setStatus("browsing", "Reading the store");
      await store.readCatalog().catch((error) => {
        // Without the catalog the agent falls back to searching; it still works.
        console.warn("Couldn't read the catalog:", error instanceof Error ? error.message : error);
      });
    }
    await runLoop();
  } catch (error) {
    if (error instanceof NoApiKeyError) {
      say({ role: "agent", text: "I'm not set up yet: add your Gemini API key to the .env file (GEMINI_API_KEY) and restart me." });
      history.pop();
    } else if (error instanceof QuotaExhaustedError) {
      const hours = Math.floor(error.resetsInSeconds / 3600);
      const minutes = Math.ceil((error.resetsInSeconds % 3600) / 60);
      say({
        role: "agent",
        text: `The free AI quota for today is used up (it resets in about ${hours ? `${hours}h ` : ""}${minutes}m). Buttons, "add those", "check out" and "yes" still work without AI. For testing, set AGENT_LLM=mock in .env.`,
      });
      history.pop();
    } else if (error instanceof RateLimitedError) {
      say({ role: "agent", text: `I've hit Gemini's free-tier limit. Please try again in about ${error.retryAfter} seconds.` });
      history.pop();
    } else if (error instanceof OpenAI.APIConnectionError) {
      say({ role: "agent", text: "Gemini took too long to answer (it's busy right now). Please send that again." });
    } else {
      console.error(error);
      say({ role: "agent", text: "Something went wrong on my side. Please try again." });
    }
    setStatus("error", "Stopped");
  } finally {
    busy = false;
    if (!pendingPayment) setStatus("idle", "Ready");
  }
}

async function runLoop() {
  for (let round = 0; round < MAX_ROUNDS; round++) {
    setStatus("thinking", round === 0 ? "Understanding your request" : "Deciding the next step");
    const think = step("think", round === 0 ? "Thinking about your request" : "Deciding the next step", "AI request");
    let message;
    try {
      const result = await complete(
        [{ role: "system", content: systemPrompt(await firewall.canary()) }, ...trimmedHistory()],
        TOOLS,
        (s) => setStatus("thinking", `Waiting ${s}s for the AI rate limit`),
      );
      message = result.message;
      think(
        "done",
        result.source === "cache" ? "Reused a saved answer (no AI request)" : result.source === "mock" ? "Offline mock (no AI request)" : result.model,
      );
    } catch (error) {
      think("failed");
      throw error;
    }

    const toolCalls = (message.tool_calls ?? []).filter(
      (c): c is ChatCompletionMessageToolCall & { type: "function" } => c.type === "function",
    );
    if (toolCalls.length === 0) {
      const reply = await firewall.checkReply(message.content?.trim() || "Sorry, I didn't get that. Could you say it another way?");
      history.push({ role: "assistant", content: reply });
      say({ role: "agent", text: reply });
      return;
    }

    // Keep the tool calls as Gemini sent them: Gemini 3 needs its thought signatures back.
    history.push({ role: "assistant", content: message.content ?? null, tool_calls: toolCalls });
    if (message.content?.trim()) say({ role: "agent", text: message.content.trim() });

    let ended: string | undefined;
    const cartReplies: string[] = [];
    for (const call of toolCalls) {
      if (ended !== undefined) {
        history.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ skipped: true }) });
        continue;
      }
      const label = TOOL_LABELS[call.function.name as ToolName] ?? call.function.name;
      const done = step("tool", label, summarizeArgs(call.function.arguments));
      const outcome = await runTool(call.function.name, call.function.arguments);
      const failed = !!(outcome.output && typeof outcome.output === "object" && "error" in outcome.output);
      done(failed ? "failed" : "done", failed ? String((outcome.output as { error: string }).error) : undefined);
      history.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(outcome.output) });
      if (ACTION_TOOLS.has(call.function.name) && !failed) cartReplies.push(describeCartChange(call.function.name, outcome.output as CartResult));
      if (outcome.endsTurn) ended = outcome.reply ?? "";
    }
    // A checkout card already says what happened; otherwise the app reports the cart change itself.
    if (ended === undefined && cartReplies.length) {
      ended = cartReplies.join(" ");
      say({ role: "agent", text: ended });
      recordSaved("shortcut");
    }
    if (ended !== undefined) {
      // Close the turn with an assistant message, so the next user message follows one.
      history.push({ role: "assistant", content: ended });
      return;
    }
  }
  say({ role: "agent", text: "That took more steps than expected, so I paused here. Tell me how you'd like to continue." });
}

function summarizeArgs(raw: string) {
  try {
    const args = JSON.parse(raw || "{}");
    if (args.queries) return args.queries.join(", ");
    if (args.items) return args.items.map((i: { sku: string; quantity?: number }) => (i.quantity !== undefined ? `${i.quantity}× ${i.sku}` : i.sku)).join(", ");
    if (args.sku) return args.sku;
    if (args.categories) return args.categories.join(", ");
    return undefined;
  } catch {
    return undefined;
  }
}
