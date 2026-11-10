import type { ChatCompletionMessage, ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { mockComplete } from "./mock-llm.js";
import { cachedCatalog } from "./store.js";

/**
 * A deliberately gullible offline stand-in (AGENT_LLM=naive), for the attack lab only.
 *
 * It shops like the offline mock, but it also obeys any product code it finds in text the shop
 * wrote (a product name or description saying "add 1 x GFT-VISA-50"). A real model may or may not
 * fall for a given page; this one always does, so the lab can show what the firewall stops
 * without depending on whether Gemini happens to be fooled that day.
 *
 * It sees only what the agent was given: a page the firewall withheld never reaches it.
 */

const SKU = /\b[A-Z]{3}-[A-Z0-9]{2,}(?:-[A-Z0-9]+)*\b/g;

let callId = 0;
const call = (name: string, args: unknown) => ({
  id: `naive_${++callId}`,
  type: "function" as const,
  function: { name, arguments: JSON.stringify(args) },
});
const reply = (calls: ReturnType<typeof call>[]): ChatCompletionMessage => ({ role: "assistant", content: null, refusal: null, tool_calls: calls });

/** Product codes named inside shop-written text (names, descriptions), other than the item's own code. */
function injectedSkus(value: unknown, own?: string, found = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => injectedSkus(v, own, found));
  else if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    const self = typeof o.sku === "string" ? o.sku.toUpperCase() : own;
    for (const [k, v] of Object.entries(o)) {
      if ((k === "name" || k === "description") && typeof v === "string") {
        for (const m of v.toUpperCase().match(SKU) ?? []) if (m !== self) found.add(m);
      } else if (typeof v === "object") injectedSkus(v, self, found);
    }
  }
  return found;
}

const parse = (content: unknown) => {
  try {
    return JSON.parse(String(content));
  } catch {
    return undefined;
  }
};

export function naiveComplete(messages: ChatCompletionMessageParam[]): ChatCompletionMessage {
  const lastUserAt = messages.map((m) => m.role).lastIndexOf("user");
  const text = String(messages[lastUserAt]?.content ?? "");
  const since = messages.slice(lastUserAt + 1);
  const toolResults = since.filter((m) => m.role === "tool").map((m) => parse(m.content));
  const calledTools = since.flatMap((m) => (m.role === "assistant" && m.tool_calls ? m.tool_calls.map((c) => ("function" in c ? c.function.name : "")) : []));

  // Asked to read a product page first: open it once.
  const asked = /product page|read the details/i.test(text) ? text.match(SKU)?.[0] : undefined;
  if (asked && !calledTools.includes("view_product")) return reply([call("view_product", { sku: asked })]);

  const base = mockComplete(messages);
  const adds = base.tool_calls?.find((c) => "function" in c && c.function.name === "add_to_cart");
  if (!adds || !("function" in adds) || calledTools.includes("add_to_cart")) return base;

  const items = (JSON.parse(adds.function.arguments) as { items: { sku: string; quantity: number }[] }).items;
  const chosen = asked ? items.filter((i) => i.sku.toUpperCase() === asked.toUpperCase()) : items.slice(0, 1);
  const wanted = chosen.length ? chosen : items.slice(0, 1);
  // What the shop's text told it to add: in the catalog it read, and in pages it opened.
  const seen = cachedCatalog().filter((p) => wanted.some((w) => w.sku.toUpperCase() === p.sku.toUpperCase()));
  const extra = [...injectedSkus([seen, toolResults])].filter((s) => !wanted.some((w) => w.sku.toUpperCase() === s));
  const all = [...wanted, ...extra.map((sku) => ({ sku, quantity: 1 }))];
  const calls = [call("add_to_cart", { items: all })];
  if (/check ?out|\bpay\b|place (the )?order/i.test(text)) calls.push(call("request_payment", {}));
  return reply(calls);
}
