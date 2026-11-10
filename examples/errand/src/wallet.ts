import fs from "node:fs";
import path from "node:path";
import type { Locator, Page } from "playwright-core";
import { highlight, pause, snapshot } from "./browser.js";
import { config, walletConfigured } from "./config.js";
import { emit, step } from "./events.js";
import type { PreparedPayment } from "./firewall.js";

/**
 * Errand's own wallet: a PayPal sandbox personal (buyer) account. When a shop
 * sends the agent to PayPal, it logs in there, checks the amount, clicks Pay
 * and follows PayPal back to the shop, the way a person would. The password
 * never appears in the activity log, the live view's step text or the ledger.
 */

export class WalletError extends Error {}

export type LedgerEntry = {
  at: number;
  merchant: string;
  amount: string;
  amountCents: number;
  /** PayPal's order id (the `token` in PayPal's checkout URL). */
  paypalOrderId: string;
  orderId?: string;
  status: "paid" | "failed";
  error?: string;
};

export type WalletInfo = {
  configured: boolean;
  mode: typeof config.wallet.mode;
  account: string;
  label: string;
  spentToday: string;
  recent: LedgerEntry[];
};

const LEDGER = path.resolve(process.env.WALLET_LEDGER || path.join("data", "wallet.json"));

function readLedger(): LedgerEntry[] {
  try {
    return JSON.parse(fs.readFileSync(LEDGER, "utf8")) as LedgerEntry[];
  } catch {
    return [];
  }
}

export function record(entry: LedgerEntry) {
  const ledger = [entry, ...readLedger()].slice(0, 200);
  fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
  fs.writeFileSync(LEDGER, JSON.stringify(ledger, null, 2));
  emit({ type: "wallet", wallet: walletInfo() });
}

/** "sb-abc12@personal.example.com" -> "sb•••@personal.example.com" */
function maskEmail(email: string) {
  const [user, domain] = email.split("@");
  return domain ? `${user.slice(0, 2)}•••@${domain}` : "•••";
}

export function walletInfo(): WalletInfo {
  const ledger = readLedger();
  const today = new Date().toDateString();
  const spent = ledger
    .filter((e) => e.status === "paid" && new Date(e.at).toDateString() === today)
    .reduce((sum, e) => sum + e.amountCents, 0);
  const account = walletConfigured() ? maskEmail(config.wallet.buyerEmail) : "";
  return {
    configured: walletConfigured(),
    mode: config.wallet.mode,
    account,
    label: account ? `PayPal sandbox wallet (${account})` : "PayPal sandbox wallet (not set up)",
    spentToday: `$${(spent / 100).toFixed(2)}`,
    recent: ledger.slice(0, 5),
  };
}

export function isWalletHost(url: string | URL) {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return config.wallet.hosts.some((h) => host === h || host.endsWith(`.${h}`));
}

// PayPal's hosted checkout changes its markup now and then, so every control
// has a few fallbacks: ids first, then accessible names.
const EMAIL = 'input#email, input[name="login_email"]';
const PASSWORD = 'input#password, input[name="login_password"]';
const NEXT = "button#btnNext";
const LOGIN = "button#btnLogin";
const PAY = '#payment-submit-btn, [data-testid="submit-button-initial"], [data-id="payment-submit-btn"]';
const PAY_NAME = /complete purchase|^pay( now)?\b|agree & pay|continue to review|^continue$/i;
const COOKIE_DECLINE = "#bannerDeclineButton, #gdprCookieBanner button:has-text('Decline')";

const visible = async (l: Locator) => (await l.count()) > 0 && (await l.first().isVisible().catch(() => false));

async function payButton(page: Page): Promise<Locator | undefined> {
  const byId = page.locator(PAY).first();
  if (await visible(byId)) return byId;
  const byName = page.getByRole("button", { name: PAY_NAME }).first();
  if (await visible(byName)) return byName;
  return undefined;
}

async function click(page: Page, locator: Locator, title: string, detail?: string) {
  const done = step("click", title, detail);
  await highlight(locator);
  await locator.click();
  done();
  await page.waitForLoadState("domcontentloaded").catch(() => {});
}

/** Logs in on PayPal if needed and returns the Pay button once the review page shows. */
async function logIn(page: Page): Promise<Locator> {
  const deadline = Date.now() + 45_000;
  let typedEmail = false;
  let typedPassword = false;
  while (Date.now() < deadline) {
    const cookie = page.locator(COOKIE_DECLINE).first();
    if (await visible(cookie)) await click(page, cookie, "Decline PayPal's optional cookies");

    const pay = await payButton(page);
    if (pay && !(await visible(page.locator(PASSWORD)))) return pay;

    const password = page.locator(PASSWORD).first();
    if (!typedPassword && (await visible(password))) {
      const done = step("type", "Type the wallet password", "••••••••");
      await highlight(password);
      await password.fill(config.wallet.buyerPassword);
      done();
      typedPassword = true;
      const login = page.locator(LOGIN).first();
      if (await visible(login)) await click(page, login, "Log in to PayPal");
      else await password.press("Enter");
      await pause(1500);
      continue;
    }

    const email = page.locator(EMAIL).first();
    if (!typedEmail && (await visible(email))) {
      const done = step("type", "Type the wallet's PayPal email", maskEmail(config.wallet.buyerEmail));
      await highlight(email);
      await email.fill(config.wallet.buyerEmail);
      done();
      typedEmail = true;
      const next = page.locator(NEXT).first();
      if (await visible(next)) await click(page, next, "Click “Next”");
      await pause(1000);
      continue;
    }

    // Some PayPal pages open on a guest/card form with a "Log in" button.
    const loginLink = page.getByRole("button", { name: /^log ?in$/i }).or(page.getByRole("link", { name: /^log ?in$/i })).first();
    if (!typedEmail && (await visible(loginLink))) {
      await click(page, loginLink, "Choose “Log in” on PayPal");
      continue;
    }

    const error = page.locator('[role="alert"]:visible, .notification-critical:visible').first();
    if (typedPassword && (await visible(error))) {
      const text = (await error.innerText()).trim();
      if (text) throw new WalletError(`PayPal didn't accept the wallet login: ${text}`);
    }
    await pause(700);
  }
  await snapshot(page);
  throw new WalletError("PayPal's payment page didn't load the way I expected, so I didn't pay.");
}

/** The amount PayPal's page says it will take: the one labelled total, else the only amount shown. */
function heldAmountCents(text: string): number | undefined {
  const cents = (s: string) => Math.round(Number(s.replace(/,/g, "")) * 100);
  const total = /total[^$\d]{0,40}\$\s?([\d,]+\.\d{2})/i.exec(text);
  if (total) return cents(total[1]);
  const all = [...new Set([...text.matchAll(/\$\s?([\d,]+\.\d{2})/g)].map((m) => cents(m[1])))];
  return all.length === 1 ? all[0] : undefined;
}

/** A payee address, if PayPal's page shows one ("Pay to shop@example.com"). Usually it shows a name only. */
function shownPayee(text: string): string | undefined {
  return /(?:pay(?:ing)?|to|merchant)\s*:?\s*([\w.+-]+@[\w-]+(?:\.[\w-]+)+)/i.exec(text)?.[1]?.toLowerCase();
}

/**
 * Pays on PayPal's hosted checkout page the shop just sent the agent to.
 * Returns once PayPal has sent the browser back to the shop.
 */
export async function payWithPayPal(
  page: Page,
  payment: { merchant: string; total: string; totalCents: number },
  commit?: (prepared: PreparedPayment) => Promise<void>,
) {
  if (!walletConfigured()) throw new WalletError("The PayPal wallet isn't set up. Add PAYPAL_BUYER_EMAIL and PAYPAL_BUYER_PASSWORD to .env.");
  const arrive = step("navigate", "Wait for PayPal's checkout page");
  try {
    await page.waitForURL((url) => isWalletHost(url), { timeout: 25_000 });
  } catch {
    arrive("failed", page.url());
    throw new WalletError(`${payment.merchant} didn't send me to PayPal, so nothing was paid.`);
  }
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  const paypalOrderId = new URL(page.url()).searchParams.get("token") ?? "";
  arrive("done", new URL(page.url()).host);
  await snapshot(page);

  const entry: LedgerEntry = {
    at: Date.now(),
    merchant: payment.merchant,
    amount: payment.total,
    amountCents: payment.totalCents,
    paypalOrderId,
    status: "failed",
  };
  try {
    const pay = await logIn(page);

    const check = step("read", "Check the amount on PayPal", payment.total);
    const text = await page.locator("body").innerText();
    const amount = (payment.totalCents / 100).toFixed(2);
    if (text.includes(amount)) check("done", `${payment.total} matches`);
    else check("failed", `Couldn't see ${payment.total} on PayPal's page`);

    // PayPal now holds the payment, waiting only for the Pay click: the firewall checks what it
    // holds (its order id, the amount it shows, the payee if shown) before anything is paid.
    if (commit) {
      if (!paypalOrderId) throw new WalletError("PayPal's page has no order id, so I didn't pay.");
      const held = heldAmountCents(text);
      if (held === undefined) throw new WalletError("I couldn't read the amount on PayPal's page, so I didn't pay.");
      await commit({ system: "paypal", reference: paypalOrderId, ready: true, status: "PAYER_ACTION_REQUIRED", amountCents: held, payeeEmail: shownPayee(text) });
    }

    const done = step("pay", `Pay ${payment.total} with PayPal`, maskEmail(config.wallet.buyerEmail));
    await highlight(pay);
    await pay.click();
    try {
      await page.waitForURL((url) => !isWalletHost(url), { timeout: 45_000 });
    } catch {
      await snapshot(page);
      done("failed", "PayPal didn't send me back to the shop");
      throw new WalletError("PayPal didn't finish the payment. Check the wallet in the PayPal sandbox.");
    }
    done("done", `Back on ${new URL(page.url()).host}`);
    entry.status = "paid";
    return { paypalOrderId, entry };
  } catch (error) {
    entry.error = error instanceof Error ? error.message : String(error);
    record(entry);
    throw error;
  }
}
