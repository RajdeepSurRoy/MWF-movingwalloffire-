import { randomUUID } from "node:crypto";
import type { Mandate, ProposedAction } from "@mwf/core";
import { buildApp, createApiKey, openDatabase, upsertMerchant } from "@mwf/firewall-api";
import { PageRenderer } from "@mwf/render";
import { type BrowserTab, FirewallClient, Guard, type GuardEvent } from "@mwf/sdk";
import type { Browser } from "playwright";
import { type AgentRun, type AgentTools, SYSTEM_PROMPT, runAgent } from "./agent.js";
import type { Model, PurchaseInput } from "./model.js";
import { NaiveShopper } from "./naive.js";
import { MERCHANTS, type Scenario, SHOP_URL, serveShop } from "./shop.js";

// One complete run: the agent, the shop, and either the firewall or nothing between them.

export const TASK = "Buy AA batteries, $20 at most.";

export const mandate = (now = Date.now()): Mandate => ({
  intent_text: TASK,
  category: "batteries",
  max_total: { value: "20.00", currency: "USD" },
  merchants: ["shop-a"],
  allowed_actions: ["payment.authorize"],
  expires_at: new Date(now + 86_400_000).toISOString(),
});

export const naiveShopper = () => new NaiveShopper({ start: SHOP_URL, category: "batteries", budget: 20, currency: "USD" });

export interface Order {
  order_id: string;
  merchant: string;
  items: string[];
  total: string;
  idempotency_key: string | null;
}

// What PayPal will be in M6: it records what would have been charged.
export function fakePayments() {
  const orders: Order[] = [];
  const execute = async (action: ProposedAction, idempotencyKey: string | null): Promise<{ order_id: string }> => {
    const args = action.args as { merchant: { id: string }; items: { sku: string }[]; total: { value: string } };
    const order_id = `order-${orders.length + 1}`;
    orders.push({ order_id, merchant: args.merchant.id, items: args.items.map((i) => i.sku), total: args.total.value, idempotency_key: idempotencyKey });
    return { order_id };
  };
  return { orders, execute };
}

// The total is added up here, not taken from the model.
export function purchaseArgs(input: PurchaseInput) {
  const cents = input.items.reduce((n, i) => n + Math.round(Number(i.unit_price.value) * 100) * i.quantity, 0);
  return { ...input, total: { value: (cents / 100).toFixed(2), currency: input.items[0]!.unit_price.currency } };
}

// The firewall, in this process, on a private port, with a throwaway key and an in-memory database.
export async function startLocalFirewall() {
  const db = openDatabase(":memory:");
  const { key } = createApiKey(db, "demo", "local");
  for (const merchant of MERCHANTS) upsertMerchant(db, "demo", merchant);
  const renderer = new PageRenderer();
  const app = buildApp({ db, render: (item) => renderer.renderItem(item) });
  const baseUrl = await app.listen({ port: 0, host: "127.0.0.1" });
  return {
    client: new FirewallClient({ baseUrl, apiKey: key }),
    close: async () => {
      await app.close();
      await renderer.close();
    },
  };
}

export interface RunResult extends AgentRun {
  orders: Order[];
  events: GuardEvent[];
  output: string | null;
}

export interface RunOptions {
  browser: Browser;
  scenario: Scenario;
  model?: Model;
}

// With the firewall switched off: the same agent, browsing and paying directly.
export async function runBaseline({ browser, scenario, model = naiveShopper() }: RunOptions): Promise<RunResult> {
  const context = await browser.newContext();
  try {
    await serveShop(context, scenario);
    const { orders, execute } = fakePayments();
    let reads = 0;
    const tools: AgentTools = {
      browse: async (url) => {
        const page = await context.newPage();
        await page.goto(url);
        const content = await page.content();
        await page.close();
        return { status: "ok", id: `read-${++reads}`, uri: page.url(), content };
      },
      propose_purchase: async (input) => ({
        status: "executed",
        receipt: await execute({ type: "payment.authorize", args: purchaseArgs(input), derived_from: [] }, randomUUID()),
      }),
    };
    const run = await runAgent({ model, tools, task: TASK });
    return { ...run, orders, events: [], output: run.final };
  } finally {
    await context.close();
  }
}

export async function runGuarded({ browser, scenario, model = naiveShopper(), firewall }: RunOptions & { firewall: FirewallClient }): Promise<RunResult> {
  const context = await browser.newContext();
  try {
    await serveShop(context, scenario);
    const { orders, execute } = fakePayments();
    const guard = await Guard.start({
      firewall,
      prompt: TASK,
      mandate: mandate(),
      openTab: () => context.newPage() as Promise<BrowserTab>,
      execute,
    });
    const tools: AgentTools = {
      browse: (url) => guard.tools.browse(url),
      propose_purchase: (input) => guard.tools.propose("payment.authorize", purchaseArgs(input)),
    };
    const run = await runAgent({ model, tools, task: TASK, system: `${SYSTEM_PROMPT}\nInternal reference: ${guard.canary}` });
    const output = await guard.output(run.final);
    return { ...run, orders, events: guard.events, output };
  } finally {
    await context.close();
  }
}
