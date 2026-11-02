// PayPal Vault spike (milestone M0): can an agent pay with a saved PayPal wallet,
// with no buyer present, using authorize -> capture and authorize -> void?
//
// Run from the repo root:
//   node --env-file=.env spikes/paypal-vault/spike.mjs setup    # prints an approval link
//   node --env-file=.env spikes/paypal-vault/spike.mjs token    # after approving in the browser
//   node --env-file=.env spikes/paypal-vault/spike.mjs run      # capture flow + void flow
//
// Sandbox only. Token and order IDs are kept in .state.json (gitignored); secrets are never printed.

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const STATE_FILE = join(dirname(fileURLToPath(import.meta.url)), ".state.json");
const { PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_API_BASE } = process.env;

if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET || !PAYPAL_API_BASE) {
  fail("PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET and PAYPAL_API_BASE must be set in .env");
}
if (!PAYPAL_API_BASE.includes("sandbox")) {
  fail("PAYPAL_API_BASE is not the sandbox. This spike only runs against the sandbox.");
}

function fail(message) {
  console.error(`✖ ${message}`);
  process.exit(1);
}

function loadState() {
  return existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : {};
}

function saveState(patch) {
  writeFileSync(STATE_FILE, JSON.stringify({ ...loadState(), ...patch }, null, 2));
}

async function accessToken() {
  const basic = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString("base64");
  const res = await fetch(`${PAYPAL_API_BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) fail(`OAuth failed: HTTP ${res.status} ${await res.text()}`);
  return (await res.json()).access_token;
}

async function call(token, method, path, body) {
  const res = await fetch(`${PAYPAL_API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      // Idempotency: retrying the same logical request must not create a second one.
      "PayPal-Request-Id": randomUUID(),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) fail(`${method} ${path} -> HTTP ${res.status}\n${JSON.stringify(json, null, 2)}`);
  return json;
}

// Step 1: setup token. The buyer approves once; after that the agent pays without them.
async function setup() {
  const token = await accessToken();
  const setupToken = await call(token, "POST", "/v3/vault/setup-tokens", {
    payment_source: {
      paypal: {
        description: "MWF agent payments (sandbox spike)",
        permit_multiple_payment_tokens: false,
        usage_pattern: "IMMEDIATE",
        usage_type: "MERCHANT",
        customer_type: "CONSUMER",
        experience_context: {
          brand_name: "MWF Sandbox",
          locale: "en-US",
          shipping_preference: "NO_SHIPPING",
          return_url: "https://example.com/mwf/return",
          cancel_url: "https://example.com/mwf/cancel",
        },
      },
    },
  });
  const approve = setupToken.links?.find((l) => l.rel === "approve")?.href;
  saveState({ setupTokenId: setupToken.id, customerId: setupToken.customer?.id });
  console.log(`✔ setup token created (status ${setupToken.status})`);
  console.log(`\nApprove with a SANDBOX personal (buyer) account:\n  ${approve}\n`);
  console.log("After approving (you'll land on example.com — that's expected), run: token");
}

// Step 2: turn the approved setup token into a reusable payment token (vault id).
async function createPaymentToken() {
  const { setupTokenId } = loadState();
  if (!setupTokenId) fail("No setup token yet — run: setup");
  const token = await accessToken();
  const paymentToken = await call(token, "POST", "/v3/vault/payment-tokens", {
    payment_source: { token: { id: setupTokenId, type: "SETUP_TOKEN" } },
  });
  saveState({ vaultId: paymentToken.id });
  console.log(`✔ payment token created; vault id saved to .state.json`);
}

// Creates an AUTHORIZE order against the vaulted wallet and returns its authorization id.
// With a vault id there is no buyer step, so the order may already carry the authorization.
async function authorizeWithVault(token, vaultId, value) {
  const order = await call(token, "POST", "/v2/checkout/orders", {
    intent: "AUTHORIZE",
    purchase_units: [{ amount: { currency_code: "USD", value }, description: "MWF spike" }],
    payment_source: { paypal: { vault_id: vaultId } },
  });
  console.log(`  order ${order.id}: status ${order.status}`);

  let auth = order.purchase_units?.[0]?.payments?.authorizations?.[0];
  if (!auth) {
    if (order.status !== "APPROVED") fail(`Order needs buyer action (status ${order.status}) — no-buyer flow failed`);
    const authorized = await call(token, "POST", `/v2/checkout/orders/${order.id}/authorize`, {});
    auth = authorized.purchase_units?.[0]?.payments?.authorizations?.[0];
    console.log(`  authorize call: status ${authorized.status}`);
  }
  if (!auth) fail("No authorization returned");
  console.log(`  authorization ${auth.id}: status ${auth.status}`);
  return { orderId: order.id, authorizationId: auth.id };
}

// Step 3: the two flows the firewall needs — ALLOW (capture) and BLOCK (void).
async function run() {
  const { vaultId } = loadState();
  if (!vaultId) fail("No vault id yet — run: setup, approve, then token");
  const token = await accessToken();

  console.log("ALLOW flow: authorize -> capture");
  const allow = await authorizeWithVault(token, vaultId, "12.50");
  const capture = await call(token, "POST", `/v2/payments/authorizations/${allow.authorizationId}/capture`, {});
  console.log(`  capture ${capture.id}: status ${capture.status}`);

  console.log("BLOCK flow: authorize -> void");
  const block = await authorizeWithVault(token, vaultId, "500.00");
  await call(token, "POST", `/v2/payments/authorizations/${block.authorizationId}/void`);
  const voided = await call(token, "GET", `/v2/payments/authorizations/${block.authorizationId}`);
  console.log(`  authorization ${block.authorizationId} after void: status ${voided.status}`);

  saveState({ lastRun: { at: new Date().toISOString(), allow, captureId: capture.id, block } });
  const ok = capture.status === "COMPLETED" && voided.status === "VOIDED";
  console.log(ok ? "\n✔ Spike passed: both flows work with no buyer present." : "\n✖ Spike finished with unexpected statuses.");
  process.exit(ok ? 0 : 1);
}

const commands = { setup, token: createPaymentToken, run };
const command = commands[process.argv[2]];
if (!command) fail(`Usage: spike.mjs <${Object.keys(commands).join("|")}>`);
await command();
