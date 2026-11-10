# FreshCart

A demo online grocery store with a built-in AI shopping assistant. Shoppers can browse, search, fill a cart and check out on their own, or ask the assistant to find items, build the cart and place the order for them.

Every brand and product is invented, product images are generated illustrations, and no real payments are taken (checkout is "pay on delivery").

## Run it

Requires Node 20+ (tested on Node 24).

```bash
npm install
```

```bash
cp .env.example .env.local
```

Open `.env.local` and paste a free Google Gemini key (from https://aistudio.google.com/apikey) into `GEMINI_API_KEY`. Then:

```bash
npm run dev
```

The store runs at http://localhost:3000. The database is created and filled automatically on first run.

| Command | What it does |
|---|---|
| `npm run dev` | Start the store locally |
| `npm run seed` | Reset the database to a clean state: 45 products, no carts, no orders |
| `npm test` | Run the tests (pricing, cart, orders, assistant tools) |
| `npm run typecheck` | Check TypeScript types |

## Settings (`.env.local`)

| Variable | Required | Default | Notes |
|---|---|---|---|
| `GEMINI_API_KEY` | For the assistant | — | Free from Google AI Studio. Without it the store still works; the chat shows a "not set up yet" message. |
| `GEMINI_MODEL` | No | `gemini-3.5-flash` | Any Gemini model that supports tool calling. |
| `GEMINI_FALLBACK_MODEL` | No | `gemini-3.5-flash-lite` | Used once when the main model hits its free limit (it has its own quota). Set it empty to turn this off. |
| `GEMINI_RPM` | No | `8` | Most AI requests the whole server sends per minute. Keep it under your free-tier limit. |
| `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET` | For PayPal | — | PayPal **sandbox** app keys. Without them the PayPal option is hidden. |
| `APP_URL` | No | from the request | The store's public address, for PayPal's return links. Only needed behind a proxy or tunnel. |
| `DATABASE_PATH` | No | `./data/freshcart.db` | SQLite file location. |

`.env.local` and the `data/` folder are git-ignored. The API key is only read on the server and never reaches the browser.

## PayPal sandbox

PayPal is an optional third way to pay, next to the demo card and pay on delivery. It uses PayPal's **sandbox**, PayPal's test environment where no real money moves. The code only talks to the sandbox, so live payments can't happen by accident.

**Set it up:**

1. Sign in at https://developer.paypal.com. Go to **Apps & Credentials**, make sure the toggle says **Sandbox**, and open the default app or create one.
2. Copy its **Client ID** and **Secret** into `.env.local`:
   ```
   PAYPAL_CLIENT_ID=...
   PAYPAL_CLIENT_SECRET=...
   ```
3. Restart `npm run dev`.
4. To pay, use a **sandbox buyer account**, not your real PayPal login. You'll find it under **Testing Tools → Sandbox Accounts**. The one ending in `@personal.example.com` comes with test money.

**How a payment works:**

1. The shopper picks **PayPal**, either on the checkout page or on the chat's checkout card.
2. The server prices the items from the database and creates a PayPal order for exactly that total. It also records what is being bought.
3. The shopper approves the payment on PayPal's page.
4. PayPal sends them back to `/api/paypal/return`. The server captures the payment and checks that the captured amount matches the recorded total.
5. Only then is the order placed, marked paid, and given the PayPal capture id. The shopper lands on the order page.

**Other cases:**

- **Cancelling:** if the shopper cancels on PayPal, nothing is ordered. They go back to where they were, with a short note, and their cart and checkout are still there.
- **Reloading the return page:** this doesn't create a second order.
- **Another browser:** only the browser that started a payment can complete it.
- **Changing the cart while paying:** items added to the cart after the PayPal step started stay in the cart. They aren't part of the paid order.

**In the chat, PayPal is linked once.** The first time a shopper pays with PayPal in the chat, the assistant opens PayPal after they say yes. They approve once, and PayPal saves the account for this store (PayPal's "vault"). From then on PayPal is the default, and the assistant charges it as soon as the shopper says yes, without leaving the chat. The same amount check applies: the order is only placed if PayPal charged exactly the store's total.

- The store keeps only PayPal's reference to the account, never a PayPal login.
- Say "unlink my PayPal" to remove it. If PayPal ever declines the saved account, the store unlinks it and nothing is charged.
- Saving accounts must be switched on for the sandbox app (Apps & Credentials → your app → Features → **Save payment methods**). New sandbox apps usually have it on.

## What's in the store

- **Pages:** home, 8 category aisles, search, product detail, cart, checkout, order history and order detail. All pages have loading, empty and error states, and work on phones and desktops.
- **Catalog:** `seed/products.json` holds 45 products, each with a SKU, a brand, a price, a unit, stock and tags.
- **Delivery:** free on orders over $35, otherwise $4.99.

## The shopping assistant

Click **Ask FreshCart** (bottom-right) or one of the prompts on the home page. The assistant runs on Google Gemini, called through the OpenAI SDK, which works because Gemini accepts the OpenAI request format. It can:

- **Suggest products.** Its replies show product cards, each with **Add** and **Buy** buttons.
- **Fill and change the cart.** For example: "add 2 avocados and a sourdough loaf".
- **Buy straight away.** Say "buy this" on a product page, or "buy 2 of those". This makes a checkout for just those items and leaves the cart alone.
- **Order and pay for you.** The assistant shows an order summary (items, total, delivery details, payment) and asks "Shall I place it?". When the shopper says yes, it places and pays for the order itself and shows the receipt. There is no Pay button to press. Payment can be the **demo card** (marked paid at once, nothing is charged, no card details are ever asked for), **PayPal** (see below) or **pay on delivery**.

Name, email and address from the shopper's last order are filled in automatically. Anything missing, or any change ("make it 1 loaf", "pay on delivery instead"), is typed in the chat, and the assistant shows the new summary before ordering.

**Try:** "Plan a pasta night for 4", then "add those", then "check out. I'm Sam Lee, sam@example.com, 9 Elm St, Springfield, tomorrow morning", then "yes".

### Built for the free tier

Gemini's free tier allows only a few requests per minute, so the assistant is designed to make as few as possible:

| What | How many AI requests |
|---|---|
| A suggestion ("ideas for breakfast") | 1. The whole catalog and the cart are in the prompt, so there's no search step. |
| "Add these" / "check out" / "buy 2 of those" | 1. Several items go in one tool call, and the server writes the reply itself instead of asking the model to describe what it did. |
| "Yes" to a ready checkout | 0. Recognised on the server. |
| "Buy this" on a product page | 0. Recognised on the server. |
| **Buy** and **Add** buttons on product cards | 0. They talk to the store directly. |

On top of that:

- **Request budget.** The server never sends more than `GEMINI_RPM` requests a minute. If the budget is full, a message waits a few seconds or gets a "try again in N seconds" reply, and the chat pauses its input until then.
- **No silent retries.** The SDK's automatic retries are off, so one 429 doesn't burn two more requests.
- **Fallback model.** If Google says the limit is reached, the request is tried once on `GEMINI_FALLBACK_MODEL`, which has its own quota. After that the server backs off for as long as Google asks.
- **Cache.** Identical requests within 10 minutes reuse the same answer, for example several people tapping the same suggestion chip.
- **Small requests.** Only the last 12 messages are sent, replies are capped at 700 tokens, and thinking is set to "minimal". The prompt starts with the parts that never change, so Gemini can cache that part of the prompt.

### Assistant tools

| Tool | What it does |
|---|---|
| `add_to_cart` / `update_cart` | Change several cart items in one call (a quantity of 0 removes an item) |
| `checkout` | Start or update a checkout: buy-now items or the cart, delivery details, payment method |
| `confirm_order` | Place and pay for the checkout. Only allowed after the shopper says yes. |
| `get_product` | The full description, for detailed questions |
| `list_orders` | Recent orders and their status |

### Guardrails

- **Prices and totals come only from the database.** They are recalculated when the checkout card is shown and again when the order is placed. The assistant chooses SKUs and quantities. It can't set a price, and anything extra it sends is ignored.
- **Every tool input is checked.** Inputs are validated with Zod. Bad input, such as an invalid email or an unknown delivery time, comes back to the model as an error message.
- **Orders need a yes.** The assistant always shows the order summary and total first. `confirm_order` is only for an explicit yes to that summary, and any change shows a new summary before anything is ordered. Only the newest checkout can be placed, and a second "yes" while a PayPal charge is running is refused, so nothing is paid twice.
- **No real payment data.** The demo card needs no details. The assistant is told never to ask for card numbers.
- **Each browser has its own session.** Carts, checkouts and orders belong to a browser session (an httpOnly cookie).
- **The assistant stays on topic.** It answers grocery questions and politely declines anything else.

## Project layout

```
seed/products.json          catalog seed data
scripts/seed.ts             npm run seed
src/lib/db/                 SQLite schema (Drizzle) + connection
src/lib/store.ts            catalog, cart and order logic (shared by pages and assistant)
src/lib/pricing.ts          the one place totals are calculated
src/lib/assistant/          tools, system prompt, checkout, Gemini client + rate limiting
src/app/api/chat/route.ts   chat endpoint (shortcuts + tool-calling loop)
src/app/actions/assistant.ts  the chat's Buy and Pay buttons (no AI request)
src/lib/paypal.ts           PayPal sandbox: create, capture, verify
src/app/api/paypal/         where PayPal sends the shopper back (return / cancel)
src/app/actions/cart.ts     server actions for the website's cart and checkout
src/components/chat/        the chat widget
src/components/ProductArt   generated product illustrations
tests/                      Vitest tests
```

## Tech

Next.js 16 (App Router) · TypeScript · Tailwind CSS 4 · SQLite via Drizzle ORM and better-sqlite3 · Zod · Google Gemini (through the OpenAI Node SDK) · Vitest
