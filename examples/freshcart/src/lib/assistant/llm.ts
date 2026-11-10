import "server-only";
import { createHash } from "node:crypto";
import OpenAI from "openai";
import type {
  ChatCompletionFunctionTool,
  ChatCompletionMessage,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions";

// Gemini speaks the OpenAI Chat Completions format at this address, so the
// OpenAI SDK works unchanged; only the key, base URL and model differ.
const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/";

export function llmConfig() {
  return {
    apiKey: process.env.GEMINI_API_KEY,
    model: process.env.GEMINI_MODEL || "gemini-3.5-flash",
    fallbackModel: process.env.GEMINI_FALLBACK_MODEL ?? "gemini-3.5-flash-lite",
    // Stay under the free tier's requests-per-minute limit for the whole server.
    rpm: Math.max(1, Number(process.env.GEMINI_RPM) || 8),
    // Gemini 3 "thinks" before answering; minimal keeps replies fast and cheap.
    reasoningEffort: process.env.GEMINI_REASONING || "minimal",
  };
}

/** The request budget is used up; `retryAfter` is in seconds. */
export class RateLimitedError extends Error {
  constructor(public retryAfter: number) {
    super("rate limited");
  }
}

// ---------- Request budget (sliding one-minute window) ----------

type Budget = { calls: number[] };
const globalForLlm = globalThis as unknown as {
  __freshcartBudget?: Budget;
  __freshcartCache?: Map<string, { message: ChatCompletionMessage; expires: number }>;
  __freshcartClient?: OpenAI;
};
const budget = (globalForLlm.__freshcartBudget ??= { calls: [] });

const WINDOW_MS = 60_000;
/** How long one chat turn may wait for a free slot before giving up. */
const MAX_WAIT_MS = 8_000;

async function takeSlot(rpm: number) {
  for (;;) {
    const now = Date.now();
    while (budget.calls.length && now - budget.calls[0] >= WINDOW_MS) budget.calls.shift();
    if (budget.calls.length < rpm) {
      budget.calls.push(now);
      return;
    }
    const waitMs = budget.calls[0] + WINDOW_MS - now;
    if (waitMs > MAX_WAIT_MS) throw new RateLimitedError(Math.ceil(waitMs / 1000));
    await new Promise((r) => setTimeout(r, waitMs + 25));
  }
}

/** Remembers that the provider said "slow down", so we stop sending for a while. */
function backOff(seconds: number) {
  const until = Date.now() + seconds * 1000;
  // Fill the window with calls that expire when the provider's limit resets.
  budget.calls = Array.from({ length: llmConfig().rpm }, () => until - WINDOW_MS);
}

// ---------- Response cache ----------
// Identical requests (same prompt, cart and conversation) get the same reply,
// e.g. several people tapping the same suggestion chip. Only plain-text
// answers are cached: anything that calls a tool must run for real.

const cache = (globalForLlm.__freshcartCache ??= new Map());
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 200;

function cacheKey(model: string, messages: ChatCompletionMessageParam[]) {
  return createHash("sha256").update(model).update(JSON.stringify(messages)).digest("hex");
}

function cacheGet(key: string) {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (hit.expires < Date.now()) {
    cache.delete(key);
    return undefined;
  }
  return hit.message;
}

function cacheSet(key: string, message: ChatCompletionMessage) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
  cache.set(key, { message, expires: Date.now() + CACHE_TTL_MS });
}

// ---------- The call ----------

function client(apiKey: string) {
  // maxRetries: 0 — the SDK's automatic retries would spend two more requests
  // of the free quota on every 429. Retrying is decided here instead.
  globalForLlm.__freshcartClient ??= new OpenAI({ apiKey, baseURL: GEMINI_BASE_URL, maxRetries: 0, timeout: 30_000 });
  return globalForLlm.__freshcartClient;
}

function isQuotaError(error: unknown) {
  return error instanceof OpenAI.APIError && (error.status === 429 || error.status === 503);
}

function retryAfterSeconds(error: unknown) {
  if (!(error instanceof OpenAI.APIError)) return 30;
  const header = Number(error.headers?.get?.("retry-after"));
  if (Number.isFinite(header) && header > 0) return Math.min(header, 120);
  // Gemini puts the wait in the message, e.g. "Please retry in 23.4s."
  const match = /retry in ([\d.]+)s/i.exec(error.message);
  return match ? Math.ceil(Number(match[1])) : 30;
}

export type CompleteResult = { message: ChatCompletionMessage; model: string; cached: boolean };

/**
 * One model call within the request budget. On a quota error from the main
 * model it tries the fallback model once (it has its own free quota).
 */
export async function complete(
  messages: ChatCompletionMessageParam[],
  tools: ChatCompletionFunctionTool[],
): Promise<CompleteResult> {
  const cfg = llmConfig();
  if (!cfg.apiKey) throw new Error("GEMINI_API_KEY is not set");
  const models = [cfg.model, ...(cfg.fallbackModel && cfg.fallbackModel !== cfg.model ? [cfg.fallbackModel] : [])];

  let lastError: unknown;
  for (const model of models) {
    const key = cacheKey(model, messages);
    const hit = cacheGet(key);
    if (hit) return { message: hit, model, cached: true };

    await takeSlot(cfg.rpm);
    try {
      const completion = await client(cfg.apiKey).chat.completions.create({
        model,
        messages,
        tools,
        temperature: 0.4,
        max_tokens: 700,
        // Not in the SDK's types for every value Gemini accepts ("minimal").
        reasoning_effort: cfg.reasoningEffort as "low",
      });
      const message = completion.choices[0]?.message;
      if (!message) throw new Error("Empty response from the model");
      if (!message.tool_calls?.length) cacheSet(key, message);
      return { message, model, cached: false };
    } catch (error) {
      lastError = error;
      if (!isQuotaError(error)) throw error;
      console.warn(`Gemini quota hit on ${model}`);
    }
  }
  const wait = retryAfterSeconds(lastError);
  backOff(wait);
  throw new RateLimitedError(wait);
}
