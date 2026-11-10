import "dotenv/config";

/** Every setting in one place. All come from `.env` (see `.env.example`). */
export const config = {
  port: Number(process.env.PORT) || 4000,
  /** The shop the agent goes to. FreshCart runs here with `npm run dev`. */
  storeUrl: (process.env.STORE_URL || "http://localhost:3000").replace(/\/+$/, ""),
  /** "chrome", "msedge", or "chromium" (the last needs `npx playwright install chromium`). */
  browserChannel: process.env.BROWSER_CHANNEL || "chrome",
  /** Set HEADED=1 to watch the agent's real browser window on screen. */
  headed: process.env.HEADED === "1",
  /** Extra delay between browser steps so the live view is easy to follow on stage. */
  stepDelayMs: Math.max(0, Number(process.env.STEP_DELAY_MS ?? 250)),

  /**
   * "gemini" uses the real AI. "mock" is an offline stand-in for tests: no API calls at all.
   * "naive" is the attack lab's gullible offline stand-in: it obeys product codes in shop text.
   */
  llmMode: (["mock", "naive"].includes(process.env.AGENT_LLM ?? "") ? process.env.AGENT_LLM : "gemini") as "gemini" | "mock" | "naive",
  /** How long identical AI requests reuse a saved answer (hours). 0 turns the cache off. */
  cacheHours: Math.max(0, Number(process.env.LLM_CACHE_HOURS ?? 72)),
  /** Read the whole store once up front, so suggestions need one AI request instead of two or more. */
  prefetchCatalog: process.env.PREFETCH_CATALOG !== "0",

  gemini: {
    apiKey: process.env.GEMINI_API_KEY || "",
    model: process.env.GEMINI_MODEL || "gemini-3.5-flash",
    fallbackModel: process.env.GEMINI_FALLBACK_MODEL ?? "gemini-3.5-flash-lite",
    rpm: Math.max(1, Number(process.env.GEMINI_RPM) || 8),
    reasoningEffort: process.env.GEMINI_REASONING || "minimal",
    /** Requests per day the app allows itself per model (0 = no local limit). Matches the free tier by default. */
    dailyLimit: Math.max(0, Number(process.env.GEMINI_DAILY_LIMIT ?? 20)),
    fallbackDailyLimit: Math.max(0, Number(process.env.GEMINI_FALLBACK_DAILY_LIMIT ?? 0)),
  },

  /** The agent's own PayPal wallet: a sandbox *personal* (buyer) account it logs in to when a shop sends it to PayPal. */
  /** The MWF agent firewall, called over its HTTP API (see src/firewall.ts). Off unless MWF_ENABLED=1. */
  firewall: {
    enabled: process.env.MWF_ENABLED === "1",
    apiUrl: (process.env.MWF_API_URL || "http://127.0.0.1:8787").replace(/\/+$/, ""),
    apiKey: process.env.MWF_API_KEY || "",
    /** The id FreshCart is registered under in the firewall's merchant registry. */
    merchantId: process.env.MWF_MERCHANT_ID || "freshcart",
    /** The most a shop may add on top of the items. FreshCart's delivery is $4.99. */
    maxFeeCents: Math.round(Number(process.env.MWF_MAX_FEE ?? 4.99) * 100),
  },

  wallet: {
    buyerEmail: process.env.PAYPAL_BUYER_EMAIL || "",
    buyerPassword: process.env.PAYPAL_BUYER_PASSWORD || "",
    /** "auto" pays with PayPal when the shop offers it, "paypal" requires it, "off" always uses the shop's other option. */
    mode: (["paypal", "off"].includes(process.env.WALLET_MODE ?? "") ? process.env.WALLET_MODE : "auto") as "auto" | "paypal" | "off",
    /** Hosts the wallet will log in on. Only PayPal's own unless you add test hosts (comma-separated). */
    hosts: ["paypal.com", ...(process.env.WALLET_EXTRA_HOSTS ?? "").split(",").map((h) => h.trim()).filter(Boolean)],
  },
};

export const walletConfigured = () => Boolean(config.wallet.buyerEmail && config.wallet.buyerPassword);
