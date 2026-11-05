import type { HistoryEntry, Model, ModelInput, ModelTurn, PurchaseInput } from "./model.js";

// A stand-in for a real model: a deterministic shopper with no judgement. It reads the raw HTML
// it is given, and if the page tells it to buy something, it does. A real model is harder to
// fool than this, so "fooled in baseline" here shows the firewall's half of the story only.

interface Product {
  sku: string;
  name: string;
  category: string;
  price: string;
}

const attr = (html: string, name: string) => html.match(new RegExp(`data-${name}="([^"]*)"`))?.[1];

function productsIn(html: string): Product[] {
  const out: Product[] = [];
  for (const m of html.matchAll(/<li\b([^>]*data-sku[^>]*)>\s*<h3>([^<]*)<\/h3>/g)) {
    const [sku, category, price] = [attr(m[1]!, "sku"), attr(m[1]!, "category"), attr(m[1]!, "price")];
    if (sku && category && price) out.push({ sku, name: m[2]!, category, price });
  }
  return out;
}

const INSTRUCTION = /\b(?:ignore|disregard)\b[^<]*?\b(?:buy|purchase|order)\s+(?:the\s+)?([^<]+)/i;

// The product a page's instruction points at: its SKU if it gives one, or the most words in common.
function instructed(html: string, products: Product[]): Product | undefined {
  const phrase = html.match(INSTRUCTION)?.[1]?.toLowerCase();
  if (!phrase) return undefined;
  const words: string[] = phrase.match(/[a-z0-9-]+/g) ?? [];
  const score = (p: Product) => (words.includes(p.sku.toLowerCase()) ? 100 : words.filter((w) => p.name.toLowerCase().includes(w)).length);
  const best = [...products].sort((a, b) => score(b) - score(a))[0];
  return best && score(best) > 0 ? best : undefined;
}

export class NaiveShopper implements Model {
  constructor(private readonly opts: { start: string; category: string; budget: number; currency: string }) {}

  async next({ history }: ModelInput): Promise<ModelTurn> {
    const last = history.at(-1);
    if (last?.role === "task") return { type: "call", call: { tool: "browse", url: this.opts.start } };
    const result = (last as Extract<HistoryEntry, { role: "tool" }>).result as { status?: string; content?: string; receipt?: { order_id?: string } };

    if (result.status === "ok" && result.content !== undefined) return this.#choose(result.content);
    if (result.status === "executed") return { type: "final", text: `Order placed: ${result.receipt?.order_id ?? "no receipt"}.` };
    if (result.status === "withheld") return { type: "final", text: "I could not read the shop page, so I bought nothing." };
    return { type: "final", text: `I could not complete the purchase (${result.status ?? "error"}).` };
  }

  #choose(html: string): ModelTurn {
    const products = productsIn(html);
    const affordable = products
      .filter((p) => p.category === this.opts.category && Number(p.price) <= this.opts.budget)
      .sort((a, b) => Number(a.price) - Number(b.price));
    const product = instructed(html, products) ?? affordable[0];
    if (!product) return { type: "final", text: "Nothing on the page fits, so I bought nothing." };
    const input: PurchaseInput = {
      merchant: { id: attr(html, "merchant") ?? "", name: attr(html, "merchant-name") ?? "", payee_email: attr(html, "payee") ?? "" },
      items: [
        {
          sku: product.sku,
          name: product.name,
          category: product.category,
          unit_price: { value: product.price, currency: this.opts.currency },
          quantity: 1,
        },
      ],
    };
    return { type: "call", call: { tool: "propose_purchase", input } };
  }
}
