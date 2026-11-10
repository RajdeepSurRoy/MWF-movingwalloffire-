import OpenAI from "openai";
import type {
  ChatCompletionFunctionTool,
  ChatCompletionMessage,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions";
import { config } from "./config.js";
import { mockComplete } from "./mock-llm.js";
import { naiveComplete } from "./naive-llm.js";
import { cacheGet, cacheKey, cacheSet, coolDown, modelAvailable, recordCall, recordSaved, usageSummary } from "./usage.js";

// Gemini accepts the OpenAI Chat Completions format at this address, so the
// OpenAI SDK works as is (same approach as the FreshCart assistant).
const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/";

export class NoApiKeyError extends Error {}
/** The free-tier request budget is used up; `retryAfter` is in seconds. */
export class RateLimitedError extends Error {
  constructor(public retryAfter: number) {
    super(`rate limited, retry in ${retryAfter}s`);
  }
}

let client: OpenAI | undefined;
let calls: number[] = [];
const WINDOW_MS = 60_000;
const MAX_WAIT_MS = 20_000;

/** Keeps the agent under GEMINI_RPM requests a minute, waiting briefly if needed. */
async function takeSlot(onWait?: (seconds: number) => void) {
  for (;;) {
    const now = Date.now();
    calls = calls.filter((t) => now - t < WINDOW_MS);
    if (calls.length < config.gemini.rpm) {
      calls.push(now);
      return;
    }
    const waitMs = calls[0] + WINDOW_MS - now;
    if (waitMs > MAX_WAIT_MS) throw new RateLimitedError(Math.ceil(waitMs / 1000));
    onWait?.(Math.ceil(waitMs / 1000));
    await new Promise((r) => setTimeout(r, waitMs + 50));
  }
}

/**
 * How long Google says to wait. A daily-quota error says hours
 * ("retryDelay":"59028s"), so this is not capped; callers cap it where needed.
 */
function retryAfterSeconds(error: unknown) {
  if (!(error instanceof OpenAI.APIError)) return 30;
  const header = Number(error.headers?.get?.("retry-after"));
  if (Number.isFinite(header) && header > 0) return header;
  const delay = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(error.message);
  if (delay) return Math.ceil(Number(delay[1]));
  const match = /retry in (?:(\d+)h)?(?:(\d+)m)?([\d.]+)s/i.exec(error.message);
  if (!match) return 30;
  return Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Math.ceil(Number(match[3]));
}

/** Worth trying the other model: quota (429), overloaded or server error, or a timeout. */
function isRetryable(error: unknown) {
  if (error instanceof OpenAI.APIConnectionError) return true; // includes timeouts
  return error instanceof OpenAI.APIError && (error.status === 429 || (error.status ?? 0) >= 500);
}

/** Every model is out of quota for a long while (usually the daily limit). */
export class QuotaExhaustedError extends Error {
  constructor(public resetsInSeconds: number) {
    super("AI quota used up");
  }
}

export type CompleteResult = { message: ChatCompletionMessage; source: "gemini" | "cache" | "mock"; model: string };

/**
 * One AI answer, spending as few free-tier requests as possible:
 * 1. Offline mock mode answers without the API.
 * 2. An identical earlier request is answered from the disk cache.
 * 3. Models that are rate-limited or at today's limit are skipped without sending anything.
 * 4. If a model hits its quota, times out or errors, the other one is tried once.
 */
export async function complete(
  messages: ChatCompletionMessageParam[],
  tools: ChatCompletionFunctionTool[],
  onWait?: (seconds: number) => void,
): Promise<CompleteResult> {
  if (config.llmMode === "mock") return { message: mockComplete(messages), source: "mock", model: "offline mock" };
  if (config.llmMode === "naive") return { message: naiveComplete(messages), source: "mock", model: "naive stand-in" };

  const key = cacheKey({ messages, tools });
  const hit = cacheGet(key);
  if (hit) {
    recordSaved("cache");
    return { message: hit, source: "cache", model: "cache" };
  }

  const { apiKey, model, fallbackModel, reasoningEffort } = config.gemini;
  if (!apiKey) throw new NoApiKeyError("GEMINI_API_KEY is not set");
  // maxRetries: 0, so one 429 doesn't silently spend two more free requests.
  client ??= new OpenAI({ apiKey, baseURL: GEMINI_BASE_URL, maxRetries: 0, timeout: 60_000 });
  const models = [model, ...(fallbackModel && fallbackModel !== model ? [fallbackModel] : [])].filter(modelAvailable);
  if (models.length === 0) throw new QuotaExhaustedError(secondsUntilAvailable());

  let lastError: unknown;
  for (const m of models) {
    await takeSlot(onWait);
    try {
      const completion = await client.chat.completions.create({
        model: m,
        messages,
        tools,
        temperature: 0.4,
        max_tokens: 800,
        // Gemini accepts "minimal", which the SDK's types don't list.
        reasoning_effort: reasoningEffort as "low",
      });
      recordCall(m);
      const message = completion.choices[0]?.message;
      if (!message) throw new Error("Empty response from Gemini");
      cacheSet(key, message);
      return { message, source: "gemini", model: m };
    } catch (error) {
      lastError = error;
      const quota = error instanceof OpenAI.APIError && error.status === 429;
      if (!quota) recordCall(m); // a failed request may still count against the quota
      if (!isRetryable(error)) throw error;
      if (quota) coolDown(m, retryAfterSeconds(error));
      console.warn(`Gemini ${quota ? "quota hit" : "request failed"} on ${m}: ${error instanceof Error ? error.message.split("\n")[0] : error}`);
    }
  }
  const quota = lastError instanceof OpenAI.APIError && lastError.status === 429;
  if (!quota) throw lastError;
  const wait = secondsUntilAvailable();
  if (wait > 120) throw new QuotaExhaustedError(wait);
  calls = Array.from({ length: config.gemini.rpm }, () => Date.now() + wait * 1000 - WINDOW_MS);
  throw new RateLimitedError(wait);
}

/** Seconds until some model can be used again (rate-limit wait or the next quota day). */
function secondsUntilAvailable() {
  const { models } = usageSummary();
  const waits = models.map((m) => {
    if (m.coolingUntil) return Math.ceil((m.coolingUntil - Date.now()) / 1000);
    if (m.limit && m.calls >= m.limit) return secondsUntilPacificMidnight();
    return 0;
  });
  return Math.max(1, Math.min(...waits));
}

function secondsUntilPacificMidnight() {
  const now = new Date();
  const pacific = new Date(now.toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
  const midnight = new Date(pacific);
  midnight.setHours(24, 0, 0, 0);
  return Math.ceil((midnight.getTime() - pacific.getTime()) / 1000);
}
