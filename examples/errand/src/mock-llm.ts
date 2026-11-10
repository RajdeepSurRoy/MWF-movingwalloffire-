import type { ChatCompletionMessage, ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { cachedCatalog, type CatalogItem } from "./store.js";

/**
 * An offline stand-in for Gemini (AGENT_LLM=mock). It picks products by
 * keyword matching against the catalog the agent read from the website and
 * answers with the same tool calls the real model would make. Use it to
 * test the UI, the browser flows and payment without spending any quota.
 * It is not smart: phrase requests with product words ("snacks", "coffee").
 */

const THEMES: Record<string, string[]> = {
  breakfast: ["egg", "milk", "bread", "coffee", "banana", "yogurt", "oat", "granola", "butter", "juice"],
  dinner: ["pasta", "spaghetti", "sauce", "tomato", "cheese", "spinach", "rice", "bean"],
  pasta: ["pasta", "spaghetti", "sauce", "tomato", "parmesan", "cheese"],
  gaming: ["chips", "popcorn", "soda", "sparkling", "chocolate", "trail", "pretzel", "cookie"],
  snack: ["chips", "popcorn", "chocolate", "trail", "pretzel", "cookie", "cracker"],
  drink: ["soda", "sparkling", "juice", "coffee", "tea", "water"],
  spicy: ["salsa", "chili", "hot", "pepper", "jalape"],
  clean: ["detergent", "soap", "towel", "sponge", "cleaner"],
  fruit: ["apple", "banana", "avocado", "berr", "lemon", "orange"],
  restock: [],
};

const STOP = new Set("a an and the for of to me my some i im i'm get buy order add please want need with tonight night two 2 3 4 then check out it".split(" "));

function score(item: CatalogItem, terms: string[]) {
  const hay = `${item.name} ${item.brand} ${item.unit} ${item.aisle}`.toLowerCase();
  return terms.reduce((s, t) => (hay.includes(t) ? s + (item.name.toLowerCase().includes(t) ? 2 : 1) : s), 0);
}

function match(text: string, limit: number) {
  const words = text.toLowerCase().match(/[a-z']+/g) ?? [];
  const terms = new Set<string>();
  for (const w of words) {
    const stem = w.replace(/(es|s)$/, "");
    for (const [theme, extra] of Object.entries(THEMES)) if (stem.startsWith(theme)) extra.forEach((t) => terms.add(t));
    if (!STOP.has(w) && w.length > 2) terms.add(stem);
  }
  return cachedCatalog()
    .filter((p) => !p.soldOut)
    .map((p) => ({ p, s: score(p, [...terms]) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => x.p);
}

let callId = 0;
function toolMessage(calls: { name: string; args: unknown }[], content: string | null = null): ChatCompletionMessage {
  return {
    role: "assistant",
    content,
    refusal: null,
    tool_calls: calls.map((c) => ({
      id: `mock_${++callId}`,
      type: "function" as const,
      function: { name: c.name, arguments: JSON.stringify(c.args) },
    })),
  };
}

export function mockComplete(messages: ChatCompletionMessageParam[]): ChatCompletionMessage {
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const text = typeof lastUser?.content === "string" ? lastUser.content : "";
  const wantsBuy = /\b(buy|order|add|get me)\b/i.test(text);
  const wantsCheckout = /check ?out|\bpay\b|place (the )?order/i.test(text);
  const products = match(text, wantsBuy ? 3 : 4);

  if (products.length === 0) {
    return {
      role: "assistant",
      refusal: null,
      content: "(Offline test mode) I couldn't match that to FreshCart products. Try product words like snacks, coffee, breakfast or pasta.",
    };
  }
  if (wantsBuy) {
    const calls: { name: string; args: unknown }[] = [
      { name: "add_to_cart", args: { items: products.map((p) => ({ sku: p.sku, quantity: 1 })) } },
    ];
    if (wantsCheckout) calls.push({ name: "request_payment", args: {} });
    return toolMessage(calls);
  }
  return toolMessage([
    {
      name: "suggest_products",
      args: {
        message: "(Offline test mode) Here's what I found on FreshCart.",
        items: products.map((p) => ({ sku: p.sku, reason: `From the ${p.aisle} aisle` })),
      },
    },
  ]);
}
