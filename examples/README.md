# Examples: a shop and an agent that use MWF

These two apps are **sample customers** of MWF, not part of it. They exist so you can watch the firewall protect a real agent in a real-looking store. Each app talks to MWF only over HTTP with its own API key: neither one imports MWF code, and MWF doesn't import theirs. Any agent platform integrates the same way.

| App | What it is | MWF's role |
|---|---|---|
| [freshcart/](freshcart) | **FreshCart**, a demo grocery store (Next.js, SQLite, PayPal sandbox checkout, its own AI assistant) | The store's assistant checks its steps with MWF |
| [errand/](errand) | **Errand**, a third-party shopping agent (Express, Playwright driving Chrome, Gemini or an offline stand-in) | Every page Errand reads and every checkout it attempts goes through MWF first |

Both are switched on by three settings in their own `.env`: `MWF_ENABLED=1`, `MWF_API_URL` and `MWF_API_KEY`. Each app's `firewall.ts` is the whole integration.

## Run the attack lab (no keys, no money)

The lab runs Errand against FreshCart with real attacks planted in the shop, once with the firewall **off** and once **on**. It reports what actually reached an order, read from the shop's database rather than from what the agent says. Each run starts its own throwaway copies of:
- the MWF API, with a fresh database and its own key
- FreshCart, with a fresh database
- a lookalike shop

Payment uses pay-on-delivery: no PayPal account and no AI key needed.

You need **Node 24** (as for the repo) and Chrome or Edge installed.

```bash
npm install                          # in the repo root (MWF)
npm install --prefix examples/freshcart
npm install --prefix examples/errand
node examples/errand/scripts/attack-lab.mjs
```

`LAB_MODEL=naive` (the default) is an offline stand-in that always obeys instructions planted in shop text, so every attack is really attempted. `LAB_MODEL=gemini` uses the real model and needs `GEMINI_API_KEY` in `examples/errand/.env`. Results from our runs are in [evidence/e2e-2026-11-10](../evidence/e2e-2026-11-10).

## Use them by hand

1. Start MWF: `npm run dev:api` in the repo root. Create a key for each app:
   ```bash
   npm run keys:create -- freshcart
   npm run keys:create -- errand
   ```
   Register the shop:
   ```bash
   npm run merchants:add -- errand freshcart FreshCart http://localhost:3000
   npm run merchants:add -- freshcart freshcart FreshCart <FreshCart PayPal email> http://localhost:3000
   ```
2. FreshCart: copy `examples/freshcart/.env.example` to `.env.local`, set the `MWF_*` values, then run `npm run dev` (http://localhost:3000).
3. Errand: copy `examples/errand/.env.example` to `.env`, set the `MWF_*` values and either a Gemini key or `AGENT_LLM=mock`, then run `npm run dev` (http://localhost:4000).
4. Watch the decisions live at http://127.0.0.1:8787/console with the Errand key.

**With PayPal:** `LAB_PAY=paypal node examples/errand/scripts/attack-lab.mjs legit price-change` makes the agent pay with its PayPal sandbox buyer account. FreshCart then checks every PayPal payment with MWF before it captures, using PayPal's own record of the amount and payee. This needs FreshCart's sandbox app keys and `MWF_PAYPAL_PAYEE` (its sandbox business account email) in `examples/freshcart/.env.local`, and the buyer account in `examples/errand/.env`; see each app's README. Use sandbox accounts only. Results: [evidence/paypal-2026-11-11](../evidence/paypal-2026-11-11).
