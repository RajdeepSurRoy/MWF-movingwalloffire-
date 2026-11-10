import type { DB } from "../db";
import { getDb } from "../db";
import type { Product } from "../db/schema";
import { getProduct } from "../store";

// The model tags products it mentions as [[SKU]]. The chat shows them as cards
// and hides the tags, so suggestions need no separate search call.
const MARKER = /\[\[([A-Za-z0-9-]{3,40})\]\]/g;

export function skusInText(text: string) {
  return [...new Set([...text.matchAll(MARKER)].map((m) => m[1].toUpperCase()))];
}

/** Products tagged in a reply that really exist, in order, at most 6. */
export function productsFromReply(text: string, db: DB = getDb()): Product[] {
  return skusInText(text)
    .map((sku) => getProduct(sku, db))
    .filter((p): p is Product => Boolean(p))
    .slice(0, 6);
}
