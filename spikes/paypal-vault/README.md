# PayPal Vault spike (M0)

**Question:** can the agent pay with a saved PayPal wallet, with no buyer present, using authorize → capture (ALLOW) and authorize → void (BLOCK)?

**Deadline:** end of 2026-11-04. If it doesn't work by then, fall back to a sandbox test card and note it in the README.

## Before you start

1. In the [PayPal Developer Dashboard](https://developer.paypal.com), open your **Sandbox** app and copy its client ID and secret into `.env` (`PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`).
2. In the same app, enable **Vault** under the app's advanced options (the docs list this as a prerequisite).
3. Under **Sandbox → Accounts**, note a **personal** (buyer) sandbox account. You'll log in with it once to approve.

## Run it (from the repo root)

```bash
node --env-file=.env spikes/paypal-vault/spike.mjs setup
```

Open the printed approval link, log in with the sandbox **buyer** account and approve. You'll land on example.com — that's expected.

```bash
node --env-file=.env spikes/paypal-vault/spike.mjs token
```

```bash
node --env-file=.env spikes/paypal-vault/spike.mjs run
```

**Pass:** the run ends with "Spike passed": a $12.50 authorization is captured (`COMPLETED`) and a $500 authorization is voided (`VOIDED`), with no buyer step.

## API flow used

Checked against PayPal's "save payment methods — purchase later (Payment Method Tokens API)" docs on 2026-11-02:

1. `POST /v3/vault/setup-tokens` — `payment_source.paypal` with `usage_type: MERCHANT`, `customer_type: CONSUMER` → `approve` link.
2. Buyer approves once.
3. `POST /v3/vault/payment-tokens` with `payment_source.token { id, type: SETUP_TOKEN }` → vault id.
4. `POST /v2/checkout/orders` with `intent: AUTHORIZE` and `payment_source.paypal.vault_id` (calls `/authorize` only if the order comes back `APPROVED` without an authorization).
5. `POST /v2/payments/authorizations/{id}/capture` or `/void`.

Every request sends a fresh `PayPal-Request-Id`. State (setup token, vault id, order IDs) is saved to `.state.json`, which is gitignored.
