import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { config } from "./config.js";
import { emit } from "./events.js";

/**
 * The agent's own browser. It is a real Chrome (or Edge) window driven by
 * Playwright, with its own cookies, so the shop sees an ordinary visitor
 * and gives it its own cart. After every step a screenshot is pushed to
 * the UI so the audience can watch the agent shop.
 */
let browser: Browser | undefined;
let context: BrowserContext | undefined;
let page: Page | undefined;

export async function getPage(): Promise<Page> {
  if (page && !page.isClosed()) return page;
  if (!browser?.isConnected()) {
    browser = await chromium.launch({
      channel: config.browserChannel === "chromium" ? undefined : config.browserChannel,
      headless: !config.headed,
    });
  }
  context = await browser.newContext({
    viewport: { width: 1280, height: 860 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 ErrandAgent/0.1",
  });
  page = await context.newPage();
  page.setDefaultTimeout(15_000);
  return page;
}

/** Starts over with a fresh browser profile: new cookies, so a new empty cart. */
export async function resetBrowser() {
  await context?.close().catch(() => {});
  context = undefined;
  page = undefined;
}

export async function closeBrowser() {
  await browser?.close().catch(() => {});
}

export const pause = (ms = config.stepDelayMs) => new Promise((r) => setTimeout(r, ms));

/** Sends what the agent's browser shows right now to the live view (or a popup it opened, like PayPal's). */
export async function snapshot(target?: Page) {
  const p = target ?? page;
  if (!p || p.isClosed()) return;
  try {
    const buffer = await p.screenshot({ type: "jpeg", quality: 62 });
    emit({ type: "frame", url: p.url(), image: `data:image/jpeg;base64,${buffer.toString("base64")}` });
  } catch {
    // A screenshot can fail mid-navigation; the next step sends a fresh one.
  }
}

/** Draws a ring around the element the agent is about to use, like a cursor. */
export async function highlight(selector: Parameters<Page["locator"]>[0] | ReturnType<Page["locator"]>) {
  const p = await getPage();
  const locator = typeof selector === "string" ? p.locator(selector).first() : selector;
  try {
    await locator.scrollIntoViewIfNeeded({ timeout: 3000 });
    await locator.evaluate((el: HTMLElement) => {
      el.style.outline = "3px solid #2563eb";
      el.style.outlineOffset = "3px";
      el.style.borderRadius ||= "6px";
    });
    await snapshot(locator.page());
    await pause();
    await locator.evaluate((el: HTMLElement) => {
      el.style.outline = "";
      el.style.outlineOffset = "";
    });
  } catch {
    // Highlighting is cosmetic; never let it break the step.
  }
}
