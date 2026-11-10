import type { Locator, Page } from "playwright-core";
import { config, walletConfigured } from "./config.js";
import { getPage, highlight, pause, snapshot } from "./browser.js";
import { emit, step, type ProductCard } from "./events.js";
import { payWithPayPal, record, WalletError, walletInfo } from "./wallet.js";
import * as firewall from "./firewall.js";

/**
 * What the agent can do on the FreshCart website. Every function works the
 * way a person would: it opens a page, reads what is on screen, clicks
 * buttons and types into the checkout form. There is no private API: the
 * agent is a third party and only sees the public website.
 */

export const MERCHANT = "FreshCart";
export const DELIVERY_SLOTS = [
  "Today, 5–7 pm",
  "Today, 7–9 pm",
  "Tomorrow, 9–11 am",
  "Tomorrow, 12–2 pm",
  "Tomorrow, 5–7 pm",
] as const;
export const CATEGORIES = [
  "produce",
  "dairy",
  "bakery",
  "pantry",
  "snacks",
  "beverages",
  "household",
  "personal-care",
] as const;

/** Thrown for problems the agent should hear about and work around. */
export class StoreError extends Error {}
/** The firewall withheld the page: nothing on it was read. */
export class WithheldError extends StoreError {}

export const toCents = (price: string) => Math.round(Number(price.replace(/[^0-9.]/g, "")) * 100) || 0;
export const formatCents = (cents: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);

/** Products the agent has seen on the site this session, so chat cards show real site data. */
export const seenProducts = new Map<string, ProductCard>();
/** The aisle each product was seen in, from the site's own navigation (for the firewall's category check). */
export const seenAisles = new Map<string, string>();

/** Firewall stops become store errors, so the AI hears the rule ids and nothing else. */
async function guarded<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (error) {
    if (error instanceof firewall.FirewallStop) {
      throw error.message.startsWith("The firewall withheld") ? new WithheldError(error.message) : new StoreError(error.message);
    }
    if (error instanceof Error && error.name === "SnapshotError") throw new StoreError("The firewall couldn't check this page, so I didn't read it.");
    throw error;
  }
}

// ---------- Navigation ----------

async function open(path: string, label: string) {
  const page = await getPage();
  const url = config.storeUrl + path;
  await guarded(firewall.checkUrl(url));
  const recorder = await firewall.watchPage(page);
  const done = step("navigate", label, url);
  try {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => {});
    await snapshot();
    done();
  } catch (error) {
    recorder?.stop();
    done("failed", `Couldn't open ${url}`);
    throw new StoreError(
      `The FreshCart website at ${config.storeUrl} isn't responding. Is it running (npm run dev in the store project)?`,
    );
  }
  // Nothing on the page is read until the firewall has cleared exactly what the browser shows.
  if (recorder) await guarded(firewall.inspectPage(page, recorder));
  return page;
}

/** Remembers which aisle the product page's breadcrumb puts this product in. */
async function rememberAisle(page: Page, sku: string) {
  const href = await page.locator('nav[aria-label="Breadcrumb"] a[href^="/c/"]').first().getAttribute("href").catch(() => null);
  if (href) seenAisles.set(sku.toUpperCase(), decodeURIComponent(href.slice(3)));
}

/** Reads every product card on the current page (search results, an aisle, related items). */
async function readProductCards(page: Page): Promise<ProductCard[]> {
  const cards = await page.$$eval("article", (articles) =>
    articles
      .map((article) => {
        const link = article.querySelector<HTMLAnchorElement>('a[href^="/p/"]');
        const texts = Array.from(article.querySelectorAll("p")).map((p) => p.textContent?.trim() ?? "");
        // The first link wraps the product picture; the last one is the name.
        const name = Array.from(article.querySelectorAll<HTMLAnchorElement>('a[href^="/p/"]'))
          .map((a) => a.textContent?.trim() ?? "")
          .pop();
        const price = Array.from(article.querySelectorAll("span"))
          .map((s) => s.textContent?.trim() ?? "")
          .find((t) => /^\$\d/.test(t));
        if (!link || !name || !price) return null;
        return {
          sku: decodeURIComponent(link.getAttribute("href")!.slice(3)),
          brand: texts[0] ?? "",
          name,
          unit: texts[1] ?? "",
          price,
          soldOut: /sold out/i.test(article.textContent ?? ""),
        };
      })
      .filter((c): c is NonNullable<typeof c> => c !== null),
  );
  return cards.map((c) => {
    const card: ProductCard = { ...c, url: `${config.storeUrl}/p/${c.sku}` };
    seenProducts.set(card.sku, card);
    return card;
  });
}

// ---------- Browsing ----------

export async function search(query: string) {
  const page = await open(`/search?q=${encodeURIComponent(query)}`, `Search FreshCart for “${query}”`);
  const done = step("read", "Read search results");
  const products = await readProductCards(page);
  done("done", `${products.length} products`);
  return products;
}

export async function browseCategory(category: string) {
  const page = await open(`/c/${encodeURIComponent(category)}`, `Open the ${category} aisle`);
  const done = step("read", "Read the aisle");
  const products = await readProductCards(page);
  for (const p of products) seenAisles.set(p.sku, category);
  done("done", `${products.length} products`);
  return products;
}

export type CatalogItem = ProductCard & { aisle: string };
let catalog: { items: CatalogItem[]; at: number } | undefined;
const CATALOG_TTL_MS = 15 * 60_000;

/**
 * Walks every aisle of the website once and remembers what it saw, so the
 * AI can recommend straight away instead of spending requests on searches.
 * It is still read from the public pages, like everything else.
 */
let catalogRun: Promise<CatalogItem[]> | undefined;

export async function readCatalog(force = false): Promise<CatalogItem[]> {
  if (!force && catalog && Date.now() - catalog.at < CATALOG_TTL_MS) return catalog.items;
  // One browser tab: a second caller waits for the walk already in progress.
  catalogRun ??= walkAisles().finally(() => (catalogRun = undefined));
  return catalogRun;
}

async function walkAisles(): Promise<CatalogItem[]> {
  const done = step("read", "Scan every aisle of FreshCart", `${CATEGORIES.length} aisles`);
  const items: CatalogItem[] = [];
  try {
    for (const aisle of CATEGORIES) {
      const page = await open(`/c/${aisle}`, `Open the ${aisle} aisle`);
      for (const card of await readProductCards(page)) {
        items.push({ ...card, aisle });
        seenAisles.set(card.sku, aisle);
      }
    }
  } catch (error) {
    done("failed");
    throw error;
  }
  catalog = { items, at: Date.now() };
  done("done", `${items.length} products`);
  return items;
}

/** The last catalog read, without opening any page. */
export const cachedCatalog = () => catalog?.items ?? [];

/** A product the agent has seen on the site: on a page this session, or in the catalog walk. */
export function findSeenProduct(sku: string): ProductCard | undefined {
  const code = sku.toUpperCase();
  return seenProducts.get(code) ?? cachedCatalog().find((p) => p.sku === code);
}

export function forgetCatalog() {
  catalog = undefined;
}

export async function viewProduct(sku: string) {
  const page = await open(`/p/${encodeURIComponent(sku)}`, `Open product ${sku}`);
  const done = step("read", "Read the product page");
  const info = await page.evaluate(() => {
    const h1 = document.querySelector("h1");
    if (!h1) return null;
    const column = h1.parentElement!;
    const paras = Array.from(column.querySelectorAll("p")).map((p) => p.textContent?.trim() ?? "");
    const about = Array.from(document.querySelectorAll("h2")).find((h) => /about this item/i.test(h.textContent ?? ""));
    return {
      name: h1.textContent?.trim() ?? "",
      brand: paras[0] ?? "",
      unit: paras[1] ?? "",
      price: paras.find((t) => /^\$\d/.test(t)) ?? "",
      availability: paras.find((t) => /stock|left/i.test(t)) ?? "",
      description: about?.nextElementSibling?.textContent?.trim() ?? "",
    };
  });
  if (!info) {
    done("failed", "Product not found");
    throw new StoreError(`FreshCart has no product with code ${sku}.`);
  }
  const card: ProductCard = {
    sku: sku.toUpperCase(),
    name: info.name,
    brand: info.brand,
    unit: info.unit,
    price: info.price,
    soldOut: /out of stock/i.test(info.availability),
    url: page.url(),
  };
  seenProducts.set(card.sku, card);
  await rememberAisle(page, card.sku);
  done("done", info.name);
  return { ...card, availability: info.availability, description: info.description };
}

// ---------- Cart ----------

export type CartView = {
  lines: { sku: string; name: string; unitPrice: string; quantity: number; total: string }[];
  subtotal: string;
  delivery: string;
  total: string;
  itemCount: number;
};

async function readSummary(page: Page) {
  return page.evaluate(() => {
    const heading = Array.from(document.querySelectorAll("h2")).find((h) => /order summary/i.test(h.textContent ?? ""));
    const box = heading?.parentElement;
    const values: Record<string, string> = {};
    box?.querySelectorAll("dl > div").forEach((row) => {
      const dt = row.querySelector("dt")?.textContent?.trim() ?? "";
      const dd = row.querySelector("dd")?.textContent?.trim() ?? "";
      if (/^subtotal/i.test(dt)) {
        values.subtotal = dd;
        values.itemCount = /\((\d+) items?\)/i.exec(dt)?.[1] ?? "0";
      } else if (/^delivery/i.test(dt)) values.delivery = dd;
      else if (/^total/i.test(dt)) values.total = dd;
    });
    return values;
  });
}

async function readCartPage(page: Page): Promise<CartView> {
  const lines = await page.$$eval("main li, body li", (items) =>
    items
      .map((li) => {
        const link = li.querySelector<HTMLAnchorElement>('a[href^="/p/"]');
        const qty = li.querySelector('[aria-label^="Quantity "]');
        if (!link || !qty) return null;
        const prices = Array.from(li.querySelectorAll("p"))
          .map((p) => p.textContent?.trim() ?? "")
          .filter((t) => /\$\d/.test(t));
        return {
          sku: decodeURIComponent(link.getAttribute("href")!.slice(3)),
          // The first link wraps the product picture; the last one is the name.
          name: Array.from(li.querySelectorAll('a[href^="/p/"]')).map((a) => a.textContent?.trim() ?? "").pop() ?? "",
          unitPrice: (prices.find((t) => /each/.test(t)) ?? "").replace(/\s*each/, ""),
          quantity: Number(qty.textContent?.trim()),
          total: prices.find((t) => !/each/.test(t)) ?? "",
        };
      })
      .filter((l): l is NonNullable<typeof l> => l !== null),
  );
  const unique = [...new Map(lines.map((l) => [l.sku, l])).values()];
  if (unique.length === 0) return { lines: [], subtotal: "$0.00", delivery: "Free", total: "$0.00", itemCount: 0 };
  const s = await readSummary(page);
  return {
    lines: unique,
    subtotal: s.subtotal ?? "",
    delivery: s.delivery ?? "",
    total: s.total ?? "",
    itemCount: Number(s.itemCount ?? 0),
  };
}

function publishCart(cart: CartView) {
  emit({ type: "cart", itemCount: cart.itemCount, total: cart.total });
}

export async function viewCart() {
  const page = await open("/cart", "Open the cart");
  const done = step("read", "Read the cart");
  const cart = await readCartPage(page);
  done("done", cart.lines.length ? `${cart.itemCount} items · ${cart.total}` : "Empty");
  publishCart(cart);
  return cart;
}

/** Opens each product page, sets the quantity and clicks "Add to cart". */
export async function addToCart(items: { sku: string; quantity: number }[]) {
  const results: { sku: string; name?: string; quantity: number; ok: boolean; error?: string }[] = [];
  for (const { sku, quantity } of items) {
    let page: Page;
    try {
      page = await open(`/p/${encodeURIComponent(sku)}`, `Open product ${sku}`);
    } catch (error) {
      if (!(error instanceof WithheldError)) throw error;
      // The product page is withheld, so it is never acted on. The item can still be added
      // from its aisle page, which the firewall checks on its own.
      results.push(await addFromAisle(sku, quantity));
      continue;
    }
    const isProductPage = (await page.getByRole("heading", { name: "About this item" }).count()) > 0;
    const name = (await page.locator("h1").first().textContent().catch(() => null))?.trim();
    if (!isProductPage || !name) {
      results.push({ sku, quantity, ok: false, error: `No product with code ${sku}` });
      continue;
    }
    await rememberAisle(page, sku);
    const addButton = page.getByRole("button", { name: "Add to cart", exact: true });
    if ((await addButton.count()) === 0) {
      results.push({ sku, name, quantity, ok: false, error: `${name} is sold out` });
      continue;
    }
    const qty = Math.max(1, Math.min(20, Math.round(quantity)));
    if (qty > 1) {
      const plus = page.getByRole("button", { name: "Increase quantity" });
      const done = step("click", `Set quantity to ${qty}`, name);
      await highlight(plus);
      for (let i = 1; i < qty; i++) {
        if (await plus.isDisabled()) break;
        await plus.click();
      }
      await snapshot();
      done();
    }
    const done = step("click", `Click “Add to cart”`, `${qty} × ${name}`);
    await highlight(addButton);
    await addButton.click();
    const outcome = await Promise.race([
      page.getByRole("button", { name: "Added ✓" }).waitFor({ timeout: 8000 }).then(() => "ok"),
      page
        .locator('p[aria-live="polite"].mt-1\\.5')
        .first()
        .waitFor({ timeout: 8000 })
        .then(async () => (await page.locator('p[aria-live="polite"].mt-1\\.5').first().textContent()) ?? "error"),
    ]).catch(() => "The page didn't confirm the item was added.");
    await snapshot();
    const ok = outcome === "ok";
    done(ok ? "done" : "failed", ok ? `${qty} × ${name}` : outcome);
    results.push({ sku, name, quantity: qty, ok, ...(ok ? {} : { error: outcome }) });
    await pause();
  }
  const cart = await viewCart();
  return { results, cart };
}

/**
 * Adds an item with the "Add" button on its aisle page, without opening its product page (used
 * when the firewall withheld that page). If the aisle page is withheld too, nothing is added.
 */
async function addFromAisle(sku: string, quantity: number) {
  const code = sku.toUpperCase();
  const aisle = seenAisles.get(code);
  if (!aisle) return { sku, quantity, ok: false, error: "The firewall withheld this product's page, and I don't know its aisle, so I didn't add it." };
  let page: Page;
  try {
    page = await open(`/c/${encodeURIComponent(aisle)}`, `Open the ${aisle} aisle to add ${code}`);
  } catch (error) {
    if (error instanceof StoreError) return { sku, quantity, ok: false, error: error.message };
    throw error;
  }
  const card = page.locator("article", { has: page.locator(`a[href="/p/${code}"]`) }).first();
  const add = card.getByRole("button", { name: /^Add .+ to cart$/ }).first();
  if ((await add.count()) === 0) return { sku, quantity, ok: false, error: `${code} can't be added from the ${aisle} aisle (sold out or not listed).` };
  const name = ((await add.getAttribute("aria-label")) ?? code).replace(/^Add /, "").replace(/ to cart$/, "");
  const qty = Math.max(1, Math.min(20, Math.round(quantity)));
  const done = step("click", `Click “Add” in the ${aisle} aisle`, `${qty} × ${name}`);
  for (let i = 0; i < qty; i++) {
    await highlight(add);
    await add.click();
    const ok = await add
      .filter({ hasText: "Added ✓" })
      .waitFor({ timeout: 8000 })
      .then(() => true, () => false);
    if (!ok) {
      done("failed", "The page didn't confirm the item was added.");
      return { sku, name, quantity: i, ok: false, error: "The page didn't confirm the item was added." };
    }
    if (i + 1 < qty) await add.filter({ hasNotText: "Added ✓" }).waitFor({ timeout: 4000 }).catch(() => {});
  }
  await snapshot();
  done("done", `${qty} × ${name}`);
  return { sku, name, quantity: qty, ok: true, note: "Added from the aisle page; the product page was withheld by the firewall and not read." };
}

/** Changes quantities on the cart page with its − / + / Remove controls. 0 removes. */
export async function updateCart(items: { sku: string; quantity: number }[]) {
  const toAdd: { sku: string; quantity: number }[] = [];
  const results: { sku: string; ok: boolean; error?: string }[] = [];
  let page = await open("/cart", "Open the cart");
  for (const { sku, quantity: target } of items) {
    const line = page.locator("li", { has: page.locator(`a[href="/p/${sku.toUpperCase()}"]`) }).last();
    if ((await line.count()) === 0) {
      if (target > 0) toAdd.push({ sku, quantity: target });
      else results.push({ sku, ok: true });
      continue;
    }
    const name = (await line.locator('a[href^="/p/"]').last().textContent())?.trim() ?? sku;
    const qtyLabel = line.locator('[aria-label^="Quantity "]');
    if (target <= 0) {
      const done = step("click", `Remove ${name}`);
      const remove = line.getByRole("button", { name: "Remove" });
      await highlight(remove);
      await remove.click();
      await line.waitFor({ state: "detached", timeout: 8000 }).catch(() => {});
      await snapshot();
      done();
      results.push({ sku, ok: true });
      continue;
    }
    const done = step("click", `Change ${name} to ${target}`);
    let current = Number(await qtyLabel.textContent());
    let guard = 0;
    while (current !== target && guard++ < 25) {
      const button = line.getByRole("button", { name: `${current < target ? "Increase" : "Decrease"} ${name}` });
      if (await button.isDisabled()) break;
      await highlight(button);
      await button.click();
      const expected = current < target ? current + 1 : current - 1;
      await page
        .waitForFunction(
          ([el, n]) => (el as HTMLElement | null)?.textContent?.trim() === String(n),
          [await qtyLabel.elementHandle(), expected] as const,
          { timeout: 8000 },
        )
        .catch(() => {});
      current = Number(await qtyLabel.textContent());
    }
    await snapshot();
    const ok = current === target;
    done(ok ? "done" : "failed", ok ? undefined : `Stopped at ${current}`);
    results.push({ sku, ok, ...(ok ? {} : { error: `Could only set ${name} to ${current} (stock limit?)` }) });
  }
  if (toAdd.length) {
    const added = await addToCart(toAdd);
    for (const r of added.results) results.push({ sku: r.sku, ok: r.ok, error: r.error });
    return { results, cart: added.cart };
  }
  page = await getPage();
  const cart = await viewCart();
  return { results, cart };
}

// ---------- Checkout ----------

export type DeliveryDetails = { name: string; email: string; address: string; deliverySlot: string };

async function fillCheckout(details: DeliveryDetails) {
  const page = await open("/checkout", "Go to checkout");
  if ((await page.locator('input[name="name"]').count()) === 0) {
    throw new StoreError("The cart is empty, so there is nothing to check out. Add items first.");
  }
  const fields: [string, string, string][] = [
    ['input[name="name"]', details.name, "Full name"],
    ['input[name="email"]', details.email, "Email"],
    ['textarea[name="address"]', details.address, "Delivery address"],
  ];
  for (const [selector, value, label] of fields) {
    const done = step("type", `Type ${label}`, value);
    const input = page.locator(selector);
    await highlight(input);
    await input.fill(value);
    done();
  }
  const slots = await page.$$eval('input[name="deliverySlot"]', (radios) =>
    radios.map((r) => (r as HTMLInputElement).value),
  );
  if (!slots.includes(details.deliverySlot)) {
    throw new StoreError(`"${details.deliverySlot}" isn't a delivery time FreshCart offers. Choose one of: ${slots.join("; ")}.`);
  }
  const done = step("select", "Choose delivery time", details.deliverySlot);
  const radio = page.locator(`input[name="deliverySlot"][value="${details.deliverySlot}"]`);
  await highlight(radio.locator(".."));
  await radio.check();
  await snapshot();
  done();
  return page;
}

async function readCheckoutLines(page: Page) {
  return page.$$eval("li", (items) =>
    items
      .map((li) => {
        const spans = li.querySelectorAll("span");
        if (spans.length !== 2) return null;
        const m = /^(\d+)\s*×\s*(.+)$/.exec(spans[0].textContent?.trim() ?? "");
        if (!m) return null;
        return { quantity: Number(m[1]), name: m[2], total: spans[1].textContent?.trim() ?? "" };
      })
      .filter((l): l is NonNullable<typeof l> => l !== null),
  );
}

export type PayWith = { kind: "paypal" | "store"; label: string };

/**
 * Picks how to pay on the checkout page: the agent's PayPal wallet when the
 * shop offers PayPal (a radio option or a "Pay with PayPal" button), otherwise
 * the shop's own default option (FreshCart's is pay on delivery).
 */
async function choosePayment(page: Page): Promise<{ payWith: PayWith; submit: Locator }> {
  const radio = page
    .getByRole("radio", { name: /paypal/i })
    .or(page.locator('input[type="radio"][value="paypal" i]'))
    .first();
  const button = page.getByRole("button", { name: /paypal/i }).first();
  // The checkout form's own submit button. FreshCart relabels it by payment method
  // ("Pay $x", "Continue to PayPal · $x", "Place order · $x"), so it isn't matched by name.
  const placeOrder = page.locator('form:has(input[name="deliverySlot"]) button[type="submit"]').first();
  const hasRadio = (await radio.count()) > 0;
  const hasButton = !hasRadio && (await button.count()) > 0;
  const offered = hasRadio || hasButton;
  const mode = config.wallet.mode;

  if (offered && mode !== "off" && walletConfigured()) {
    if (hasRadio) {
      const done = step("select", "Choose PayPal as the payment method");
      await highlight(radio.locator(".."));
      await radio.check();
      done();
    }
    return { payWith: { kind: "paypal", label: walletInfo().label }, submit: hasRadio ? placeOrder : button };
  }
  if (mode === "paypal") {
    throw new StoreError(
      !offered
        ? `${MERCHANT}'s checkout doesn't offer PayPal, and the wallet is set to pay only with PayPal (WALLET_MODE=paypal).`
        : "The PayPal wallet isn't set up. Add PAYPAL_BUYER_EMAIL and PAYPAL_BUYER_PASSWORD to .env.",
    );
  }
  const checked = await page
    .locator('fieldset:has(legend:text-matches("payment", "i")) input[type="radio"]:checked')
    .first()
    // The option's name: the label's first line ("Demo card"), not its description.
    .evaluate((el) => {
      const label = el.closest("label") as HTMLElement | null;
      const name = label?.querySelector("span > span")?.textContent?.trim();
      return name || label?.innerText.trim().split("\n")[0] || "";
    })
    .catch(() => "");
  const fallback = (await page.locator('fieldset:has(legend:text-matches("payment", "i")) p').first().textContent().catch(() => null))?.trim();
  return { payWith: { kind: "store", label: `${checked || fallback || "Pay on delivery"} (${MERCHANT})` }, submit: placeOrder };
}

/** Fills in the checkout form and reads the final total, stopping just before "Place order". */
export async function prepareCheckout(details: DeliveryDetails) {
  const page = await fillCheckout(details);
  const { payWith } = await choosePayment(page);
  const done = step("read", "Read the order total");
  const summary = await readSummary(page);
  const lines = await readCheckoutLines(page);
  const errors = await page.locator('p[role="alert"]').allTextContents();
  done("done", summary.total);
  if (errors.length) throw new StoreError(errors.join(" "));
  return {
    lines,
    subtotal: summary.subtotal ?? "",
    delivery: summary.delivery ?? "",
    total: summary.total ?? "",
    totalCents: toCents(summary.total ?? ""),
    payWith,
    origin: new URL(page.url()).origin,
  };
}

/**
 * The checkout as the firewall sees it: the cart's lines with their aisles, the delivery fee,
 * the total and the address the browser is really at. Read from the pages, never from the AI.
 */
export async function readPurchase(details: DeliveryDetails) {
  const cart = await viewCart();
  const checkout = await prepareCheckout(details);
  const purchase: firewall.Purchase = {
    origin: checkout.origin,
    lines: cart.lines.map((l) => ({
      sku: l.sku,
      name: l.name,
      category: seenAisles.get(l.sku.toUpperCase()) ?? "unknown",
      unitCents: toCents(l.unitPrice),
      quantity: l.quantity,
    })),
    feeCents: /free/i.test(checkout.delivery) ? 0 : toCents(checkout.delivery),
    totalCents: checkout.totalCents,
  };
  return { checkout, purchase };
}

/**
 * Places the order. The form is filled in again and the total re-read; if
 * the shop's total no longer matches what the user approved, it stops.
 */
/** The firewall's commit: called once, right before the irreversible click. Throws to stop. */
export type CommitHook = (prepared?: firewall.PreparedPayment) => Promise<void>;

export async function placeOrder(details: DeliveryDetails, approvedTotalCents: number, commit?: CommitHook) {
  const page = await fillCheckout(details);
  const summary = await readSummary(page);
  const totalCents = toCents(summary.total ?? "");
  const { payWith, submit } = await choosePayment(page);
  // Paying on delivery: nothing is prepared anywhere else, so the firewall's commit runs here,
  // before "Place order". With PayPal it runs on PayPal's page, before "Pay", once PayPal holds
  // the payment. Errand's own total check below stays as a second line.
  if (commit && payWith.kind !== "paypal") await commit();
  if (totalCents !== approvedTotalCents) {
    throw new StoreError(
      `The total changed from ${formatCents(approvedTotalCents)} to ${summary.total} since you approved it, so I didn't place the order.`,
    );
  }
  const label = ((await submit.textContent()) ?? "Place order").replace(/\s+/g, " ").trim();
  const done = step("click", `Click “${label}”`, summary.total);
  await highlight(submit);
  await submit.click();
  let paid: Awaited<ReturnType<typeof payWithPayPal>> | undefined;
  try {
    if (payWith.kind === "paypal") {
      done("done", "Going to PayPal");
      try {
        paid = await payWithPayPal(page, { merchant: MERCHANT, total: summary.total ?? formatCents(totalCents), totalCents }, commit);
      } catch (error) {
        if (error instanceof WalletError) {
          const errors = await page.locator('p[role="alert"]').allTextContents().catch(() => []);
          throw new StoreError(errors.join(" ") || error.message);
        }
        throw error;
      }
    }
    await page.waitForURL(/\/orders\/FC-[A-Z0-9]{6}/, { timeout: 15_000 });
  } catch (error) {
    if (error instanceof StoreError) throw error;
    const errors = await page.locator('p[role="alert"]').allTextContents();
    await snapshot();
    done("failed", errors.join(" ") || "No confirmation page");
    const message = errors.join(" ") || "FreshCart didn't confirm the order.";
    if (paid) {
      // The wallet paid on PayPal, so the ledger keeps the payment even though the shop didn't confirm.
      record({ ...paid.entry, error: message });
      throw new StoreError(`${message} The PayPal sandbox payment (${paid.paypalOrderId}) did go through.`);
    }
    throw new StoreError(message);
  }
  await page.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => {});
  await snapshot();
  const orderId = /\/orders\/(FC-[A-Z0-9]{6})/.exec(page.url())![1];
  done("done", orderId);
  if (paid) record({ ...paid.entry, orderId });
  const read = step("read", "Read the order confirmation", orderId);
  const confirmation = await page.locator("main, body").first().innerText();
  read();
  emit({ type: "cart", itemCount: 0, total: "$0.00" });
  return {
    orderId,
    url: page.url(),
    total: summary.total ?? formatCents(totalCents),
    payWith,
    paypalOrderId: paid?.paypalOrderId,
    confirmation: confirmation.slice(0, 600),
  };
}

export async function listOrders() {
  const page = await open("/orders", "Open order history");
  const done = step("read", "Read past orders");
  const orders = await page.$$eval('a[href^="/orders/FC-"]', (links) =>
    links.map((a) => ({
      orderId: a.getAttribute("href")!.split("/").pop()!,
      summary: (a.textContent ?? "").replace(/\s+/g, " ").trim(),
    })),
  );
  done("done", `${orders.length} orders`);
  return orders;
}
