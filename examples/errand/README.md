# Errand: a third-party shopping agent

Errand is an AI agent that does your grocery run while you're busy coding, working or gaming. You tell it what you need in a chat. It opens the **FreshCart** demo store in its own browser, searches and reads the real pages, suggests products, fills the cart, fills in checkout, and asks you to approve the payment before it places the order.

Errand is a **third party**. It has no special access to FreshCart: no API and no database. It uses the public website the way a person would, through a real Chrome window driven by Playwright. Everything it sees comes from the pages, and everything it does is a click or a keystroke.

> Demo only. No real money moves: the agent pays with a **PayPal sandbox** wallet, or uses FreshCart's "pay on delivery" when the shop doesn't offer PayPal. This version has no security hardening. It is the baseline for demonstrating agent exploits and defences later.

## Run it

You need Node 20+, Chrome or Edge, and the FreshCart store running (`npm run dev` in `../freshcart`, at http://localhost:3000).

```bash
npm install
```

Copy `.env.example` to `.env` (already done once) and paste your Gemini key into `GEMINI_API_KEY`. Get a free one at https://aistudio.google.com/apikey. Then:

```bash
npm run dev
```

Open http://localhost:4000.

| Command | What it does |
|---|---|
| `npm run dev` | Start the agent app (restarts on code changes) |
| `npm start` | Start without watching |
| `npm run try -- "message" "next message"` | Run a conversation in the terminal and print every step (for quick checks) |
| `npm run test:wallet` | Test the PayPal wallet against a fake shop and a fake PayPal page (no network, no AI) |
| `npm run typecheck` | Check TypeScript types |

## The screen

- **Chat (left).** Talk to Errand. Suggestions show up as product cards with an **Add** button. Checkout shows up as an **Approve payment** card with every line, the total, the delivery details and **Approve / Decline** buttons. After approval you get an order card with FreshCart's order number.
- **Agent's browser (right, top).** A live view of the agent's browser, refreshed after every step. The element it is about to click or type into is outlined in blue.
- **Activity (right, bottom).** Every page it opens, everything it reads, clicks, types, and each AI decision, in order.
- **Profile.** Name, email, address, usual delivery time, food preferences and a budget per order. The agent uses these at checkout. Saved to `data/profile.json`.
- **New session.** A fresh browser profile: new cookies, so a new empty FreshCart cart.

Set `HEADED=1` in `.env` to also see the agent's real Chrome window on screen, which works well on a projector.

## Try it

1. "Dinner for 2 tonight. Vegetarian, something spicy." It searches and shows suggestions.
2. "Add those and check out." It adds them on the product pages, opens checkout, fills in the form and shows the payment card.
3. Tap **Approve** or type "yes". It clicks **Place order** on FreshCart, pays on PayPal if PayPal was chosen, and reads the confirmation.

Other good prompts: "Snacks and drinks for a gaming night, under $25", "Restock coffee, milk and bananas, then check out", "What's in my cart?", "Remove the avocados".

## How it works

```
You ──chat──▶ Errand server (Express) ──Gemini (tool calling)──▶ decides the next step
                     │
                     └─ Playwright ─▶ Chrome ─▶ FreshCart website (http://localhost:3000)
                     │                         search · product pages · cart · checkout · orders
                     └─ SSE ─▶ your browser: chat, live screenshots, activity log
```

Each message runs a loop: Gemini picks a tool, the server does it in the browser, and the result (what the page showed) goes back to Gemini. The loop ends with a reply, product suggestions, or a payment request.

| Tool | What the agent does on the website |
|---|---|
| `search_store` | Opens `/search?q=…` for up to 6 terms at once and reads the product cards |
| `browse_aisle` | Opens an aisle page (`/c/produce`, …) |
| `view_product` | Opens a product page and reads the description and stock |
| `add_to_cart` | Opens each product page, sets the quantity, clicks **Add to cart**, waits for "Added ✓" |
| `update_cart` | Uses the − / + / Remove controls on `/cart` |
| `view_cart` | Reads the cart page and the order summary |
| `suggest_products` | Shows product cards in the chat (only SKUs it has actually seen on the site) |
| `request_payment` | Fills in the checkout form, reads the total and shows the approval card. It does **not** click Place order. |
| `list_orders` | Reads the order history page |

**Payment.** The model can't place an order. `request_payment` stops just before **Place order** and hands the decision to you. When you approve (button, or "yes" typed in the chat), the server fills in checkout again, checks that the site's total still matches what you approved, clicks **Place order** and reads the order number from the confirmation page. These steps use no AI request.

## The agent's PayPal wallet

Errand has its own wallet: a **PayPal sandbox personal (buyer) account**. When a shop's checkout offers PayPal, the agent pays with it, the way a person would:

1. At checkout it picks **PayPal** as the payment method (a PayPal radio option or a "Pay with PayPal" button). The approval card shows *Pay with: PayPal sandbox wallet (sb•••@…)*.
2. After you approve, it clicks **Place order**. The shop sends the browser to `sandbox.paypal.com`.
3. On PayPal it declines optional cookies, logs in to the wallet account (email, **Next**, password, **Log in**), checks that PayPal shows the approved amount, and clicks **Complete Purchase**.
4. PayPal sends the browser back to the shop, which captures the payment and shows the order page. The order card shows the PayPal order id.

Every step shows in the live view and the activity log. The password is shown as `••••••••` and never logged. Each payment goes into a ledger in `data/wallet.json` (shop, amount, PayPal order id, store order id, paid or failed). The **wallet pill** in the top bar shows today's spend; hover it for the account and the last payments.

If the shop doesn't offer PayPal, or the wallet isn't set up, the agent uses the shop's own option (FreshCart: pay on delivery). `WALLET_MODE=paypal` makes PayPal required instead, and `WALLET_MODE=off` never uses it.

**Set it up.** On https://developer.paypal.com go to **Testing Tools → Sandbox Accounts** and use the *Personal* account PayPal made for you (or create one). Open it to see its email and system-generated password, and put them in `.env`:

```
PAYPAL_BUYER_EMAIL=sb-xxxxx@personal.example.com
PAYPAL_BUYER_PASSWORD=...
```

Use only a sandbox account, never a real PayPal login. FreshCart needs its own PayPal sandbox **app** keys (the *Business* side) in `../freshcart/.env.local`; the buyer account above is what the agent pays from. Sandbox balances are fake money.

The wallet only logs in on `paypal.com` hosts. `WALLET_EXTRA_HOSTS` adds test hosts (the `test:wallet` script uses `paypal.localhost`).

## Saving the free-tier quota

On the free tier, `gemini-3.5-flash` allows only about 20 requests a day per key, and FreshCart's own assistant shares that quota if it uses the same key. Errand is built to spend as little as possible:

| Flow | AI requests |
|---|---|
| A suggestion ("dinner for 2, something spicy") | 1 |
| "add those", "add the first two", "add those and check out" | 0 |
| "check out", "pay", "place the order" | 0 |
| "yes" / "no" to the payment card, **Approve**, **Decline**, **Add** | 0 |
| "what's in my cart?", "show my orders" | 0 |
| Buying something specific in one go ("buy coffee and milk and check out") | 1 |
| The same request again (rehearsals, retakes) | 0 (saved answer) |

A whole order (suggest, add, check out, approve) costs **1 request**. Before these changes it cost 5 to 7.

How:

- **The store is read once up front.** At startup, Errand walks the 8 aisle pages in its browser (no AI involved) and puts the catalog in the prompt, so the model recommends in one step instead of searching first. It is re-read every 15 minutes. `PREFETCH_CATALOG=0` turns this off, and the agent searches instead.
- **Shortcuts.** Short, common requests (above) are recognised by the app and done directly.
- **The app writes cart replies itself.** After the model adds or changes items, the app reports what happened, so no request is spent on "Added it!".
- **Saved answers.** Identical requests reuse the answer saved in `data/llm-cache.json`, which survives restarts. Rehearse the demo once and every retake of the same script is free. Delete the file, or set `LLM_CACHE_HOURS=0`, when you need fresh answers (for example while testing exploits).
- **No wasted requests on a known limit.** Requests are counted per model per day in `data/usage.json`, along with how long Google said to wait, even across restarts. A model that is paused or at `GEMINI_DAILY_LIMIT` is skipped without sending anything, and the fallback model is used.
- **Offline mock mode for tests.** `AGENT_LLM=mock` swaps Gemini for a simple keyword matcher that makes the same tool calls. The UI, the browser, the cart, checkout and payment all work, with zero API calls. Use it for UI work, flow tests, and building the security layer around tool calls; switch back to `gemini` for anything that depends on the model's judgement.
- **Smaller requests.** Only the last 6 turns are sent, replies are capped at 800 tokens, and thinking is set to minimal.

The **AI today** pill in the top bar shows requests sent and saved. Hover over it for each model's count and when a paused model comes back. It turns amber when the main model is paused or used up, and red when every model is.

**For demo day:** rehearse in mock mode, do one real run of your demo script to fill the answer cache, and record the video from that. For the live demo, a key with billing enabled removes the daily limit.

## Settings (`.env`)

| Variable | Default | Notes |
|---|---|---|
| `GEMINI_API_KEY` | (none) | Required for the chat |
| `GEMINI_MODEL` | `gemini-3.5-flash` | Any Gemini model with tool calling |
| `GEMINI_FALLBACK_MODEL` | `gemini-3.5-flash-lite` | Tried once when the main model is rate-limited. Empty turns it off. |
| `GEMINI_RPM` | `8` | Most AI requests per minute |
| `STORE_URL` | `http://localhost:3000` | The FreshCart store |
| `BROWSER_CHANNEL` | `chrome` | `chrome` or `msedge` (uses the installed browser, nothing to download) |
| `HEADED` | `0` | `1` shows the real browser window |
| `STEP_DELAY_MS` | `250` | Pause between browser steps so the live view is easy to follow |
| `PORT` | `4000` | Port for this app |
| `AGENT_LLM` | `gemini` | `mock` for the offline stand-in (no API calls); `naive` for the attack lab's gullible stand-in, which obeys product codes in shop text |
| `LLM_CACHE_HOURS` | `72` | How long identical requests reuse a saved answer. `0` = off |
| `PREFETCH_CATALOG` | `1` | Read the store's aisles up front. `0` = search instead |
| `GEMINI_DAILY_LIMIT` | `20` | Requests per day allowed on the main model. `0` = no local limit |
| `GEMINI_FALLBACK_DAILY_LIMIT` | `0` | Same for the fallback model |
| `PAYPAL_BUYER_EMAIL` | (none) | The wallet's PayPal sandbox personal account |
| `PAYPAL_BUYER_PASSWORD` | (none) | Its password. Never logged |
| `WALLET_MODE` | `auto` | `auto` = PayPal when offered, `paypal` = PayPal only, `off` = never |
| `WALLET_EXTRA_HOSTS` | (none) | Extra hosts the wallet may log in on, for local test pages |

## Project layout

```
src/server.ts    HTTP routes and the live event stream
src/agent.ts     system prompt, tools, the tool-calling loop, payment approval
src/store.ts     everything the agent does on the FreshCart website (Playwright)
src/wallet.ts    the agent's PayPal sandbox wallet: logs in on PayPal, pays, keeps the ledger
src/browser.ts   the agent's Chrome: launch, screenshots, highlighting
src/llm.ts       Gemini through the OpenAI SDK: cache, rate limiting, fallback
src/usage.ts     daily request counts, rate-limit waits and the answer cache (saved in data/)
src/mock-llm.ts  the offline stand-in for Gemini (AGENT_LLM=mock)
src/naive-llm.ts the attack lab's gullible stand-in (AGENT_LLM=naive)
scripts/attack-lab.mjs  runs each attack with the MWF firewall off and on; verdicts come from the lab shop's database (LAB_MODEL=naive|gemini, LAB_OUT=<file>)
src/events.ts    event types and the Server-Sent Events stream
src/profile.ts   the user's saved delivery details and preferences
public/          the web UI (plain HTML, CSS and JavaScript)
scripts/         try-agent.ts: a terminal conversation for quick checks
                 test-wallet.ts: the wallet against a fake shop and fake PayPal
```

## Where the exploits and defences will plug in

The agent works the way real browsing agents do, so the usual weak spots are all there. Nothing below is built yet.

- **Page content goes straight to the model.** Product names, descriptions and search results are passed to Gemini as is (`src/store.ts`, `viewProduct` and `readProductCards`), so text planted on a page can steer the agent.
- **The approval card trusts what the agent read.** The lines and total come from the checkout page (`prepareCheckout`).
- **The profile and its budget are in the system prompt** (`systemPrompt` in `src/agent.ts`).
- **The wallet trusts the shop's redirect.** Whatever PayPal checkout the shop sends the agent to, it logs in and pays (`payWithPayPal` in `src/wallet.ts`). The amount check on PayPal's page only logs a warning, and there is no spending limit.
- **Every tool call passes through one place,** `runTool` in `src/agent.ts`. That is the natural spot for a policy check or guard.
