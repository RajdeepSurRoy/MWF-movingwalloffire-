// Tests the agent's PayPal wallet end to end without PayPal or FreshCart:
// a fake shop (127.0.0.1:4555) whose checkout offers PayPal, and a fake PayPal
// checkout (paypal.localhost:4556) with the same login -> review -> pay steps.
//   npm run test:wallet           (runs "paypal" and "off")
//   npx tsx scripts/test-wallet.ts paypal|off
import http from "node:http";
import os from "node:os";
import path from "node:path";

// Test settings, set before the app's config is loaded. Your .env values are not used for these.
const mode = process.argv[2] === "off" ? "off" : "paypal";
Object.assign(process.env, {
  STORE_URL: "http://127.0.0.1:4555",
  STEP_DELAY_MS: "0",
  WALLET_MODE: mode,
  PAYPAL_BUYER_EMAIL: "sb-test-buyer@personal.example.com",
  PAYPAL_BUYER_PASSWORD: "Fake-Test-Pass-123",
  WALLET_EXTRA_HOSTS: "paypal.localhost",
  WALLET_LEDGER: path.join(os.tmpdir(), "errand-wallet-test.json"),
});
console.log(`Wallet test, WALLET_MODE=${mode}`);

const SLOT = "Today, 7–9 pm";
let seenPassword = "";
let seenEmail = "";

const page = (body: string) => `<!doctype html><html><head><meta charset="utf-8"></head><body><main>${body}</main></body></html>`;
const formBody = (req: http.IncomingMessage) =>
  new Promise<URLSearchParams>((r) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => r(new URLSearchParams(d)));
  });

const shop = http.createServer(async (req, res) => {
  const url = new URL(req.url!, "http://127.0.0.1:4555");
  if (url.pathname === "/checkout" && req.method === "GET") {
    res.end(page(`<form method="post" action="/checkout">
      <input name="name"><input name="email"><textarea name="address"></textarea>
      <label><input type="radio" name="deliverySlot" value="${SLOT}" checked>${SLOT}</label>
      <fieldset><legend>Payment</legend>
        <label><input type="radio" name="payment" value="card" checked><span><span>Demo card</span><span>Marked paid at once.</span></span></label>
        <label><input type="radio" name="payment" value="paypal"><span><span>PayPal (sandbox)</span><span>Approve with a PayPal sandbox test account.</span></span></label>
        <label><input type="radio" name="payment" value="cash_on_delivery"><span><span>Pay on delivery</span><span>Pay when your groceries arrive.</span></span></label>
      </fieldset>
      <section><h2>Order summary</h2><dl><div><dt>Subtotal (2 items)</dt><dd>$9.34</dd></div><div><dt>Delivery</dt><dd>$3.00</dd></div><div><dt>Total</dt><dd>$12.34</dd></div></dl></section>
      <button type="submit" id="submit">Pay $12.34</button></form>
      <script>
        // Like FreshCart: the button's label follows the chosen payment method.
        const labels = { card: "Pay $12.34", paypal: "Continue to PayPal · $12.34", cash_on_delivery: "Place order · $12.34" };
        document.querySelectorAll('input[name="payment"]').forEach((r) =>
          r.addEventListener("change", () => (document.getElementById("submit").textContent = labels[r.value])));
      </script>`));
  } else if (url.pathname === "/checkout") {
    const f = await formBody(req);
    const to = f.get("payment") === "paypal" ? "http://paypal.localhost:4556/checkoutnow?token=TESTTOKEN123" : f.get("payment") === "card" ? "/orders/FC-CRD111" : "/orders/FC-COD111";
    res.writeHead(303, { location: to }).end();
  } else if (url.pathname === "/api/paypal/return") {
    res.writeHead(303, { location: url.searchParams.get("token") === "TESTTOKEN123" ? "/orders/FC-PPL123?placed=1" : "/?paypal=failed" }).end();
  } else if (url.pathname.startsWith("/orders/")) {
    res.end(page(`<h1>Order ${url.pathname.split("/").pop()} placed</h1>`));
  } else res.end(page("home"));
});

const paypal = http.createServer(async (req, res) => {
  const url = new URL(req.url!, "http://paypal.localhost:4556");
  if (url.pathname === "/checkoutnow") {
    res.end(page(`<div id="gdprCookieBanner"><button id="bannerDeclineButton" onclick="this.parentNode.remove()">Decline</button></div>
      <form action="/signin" method="post"><input type="hidden" name="token" value="${url.searchParams.get("token")}">
      <input id="email" name="login_email"><button id="btnNext" type="submit">Next</button></form>`));
  } else if (url.pathname === "/signin") {
    const f = await formBody(req);
    seenEmail = f.get("login_email") ?? "";
    res.end(page(`<form action="/review" method="post"><input type="hidden" name="token" value="${f.get("token")}">
      <input id="password" type="password" name="login_password"><button id="btnLogin" type="submit">Log In</button></form>`));
  } else if (url.pathname === "/review") {
    const f = await formBody(req);
    seenPassword = f.get("login_password") ?? "";
    res.end(page(`<p>Pay FreshCart</p><p>$12.34 USD</p>
      <a href="http://127.0.0.1:4555/api/paypal/return?token=${f.get("token")}"><button id="payment-submit-btn">Complete Purchase</button></a>`));
  } else res.end(page("?"));
});

await new Promise<void>((r) => shop.listen(4555, "127.0.0.1", r));
await new Promise<void>((r) => paypal.listen(4556, "127.0.0.1", r));

const store = await import("../src/store.js");
const { walletInfo } = await import("../src/wallet.js");
const { subscribe } = await import("../src/events.js");
const { closeBrowser } = await import("../src/browser.js");
let emitted = "";
const onEvent = (e: any) => {
  if (e.type !== "frame") emitted += JSON.stringify(e);
  if (e.type === "step" && e.step.status !== "running") console.log(`  [${e.step.status}] ${e.step.label}${e.step.detail ? ` — ${e.step.detail}` : ""}`);
};
subscribe({
  writeHead() {},
  on() {},
  write(chunk: string) {
    if (chunk.startsWith("data: ")) onEvent(JSON.parse(chunk.slice(6)));
  },
} as never);

const details = { name: "Alex Rivera", email: "alex@example.com", address: "42 Commit Lane, Springfield", deliverySlot: SLOT };
let ok = true;
try {
  const prep = await store.prepareCheckout(details);
  console.log("prepare:", prep.total, prep.payWith);
  const order = await store.placeOrder(details, prep.totalCents);
  console.log("order:", order.orderId, order.payWith.kind, order.paypalOrderId);
  const expectPayPal = process.env.WALLET_MODE !== "off";
  ok = order.orderId === (expectPayPal ? "FC-PPL123" : "FC-CRD111");
  if (expectPayPal) {
    ok &&= seenEmail === process.env.PAYPAL_BUYER_EMAIL && seenPassword === process.env.PAYPAL_BUYER_PASSWORD;
    console.log("fake PayPal received the right login:", seenEmail === process.env.PAYPAL_BUYER_EMAIL && seenPassword === process.env.PAYPAL_BUYER_PASSWORD);
    console.log("ledger:", JSON.stringify(walletInfo().recent[0]));
  }
  // The password must never show up in what the app emits.
  const leaked = emitted.includes(process.env.PAYPAL_BUYER_PASSWORD!);
  console.log("password in emitted events:", leaked);
  ok &&= !leaked;
} catch (e) {
  ok = false;
  console.error("FAILED:", e);
}
console.log(ok ? "PASS" : "FAIL");
await closeBrowser();
shop.close();
paypal.close();
process.exit(ok ? 0 : 1);
