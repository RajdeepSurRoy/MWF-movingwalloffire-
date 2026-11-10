import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { ChatCompletionMessage } from "openai/resources/chat/completions";
import { config } from "./config.js";
import { emit } from "./events.js";

/**
 * Keeps the free tier alive across restarts:
 * - counts AI requests per model per day (Google resets daily quotas at midnight Pacific time),
 * - remembers when a model is rate-limited, so a restart doesn't waste a request finding out again,
 * - caches model answers on disk, so rehearsing the same demo replays them for free.
 */

type UsageFile = {
  day: string;
  calls: Record<string, number>;
  cacheHits: number;
  saved: number;
  coolingUntil: Record<string, number>;
};

const USAGE_FILE = "data/usage.json";
const CACHE_FILE = "data/llm-cache.json";

/** Google's quota day: midnight to midnight, Pacific time. */
const quotaDay = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date());

function load<T>(file: string, fallback: T): T {
  try {
    if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    // A broken file starts fresh.
  }
  return fallback;
}

function save(file: string, data: unknown) {
  mkdirSync("data", { recursive: true });
  writeFileSync(file, JSON.stringify(data));
}

let usage = load<UsageFile>(USAGE_FILE, { day: quotaDay(), calls: {}, cacheHits: 0, saved: 0, coolingUntil: {} });

function today() {
  if (usage.day !== quotaDay()) usage = { day: quotaDay(), calls: {}, cacheHits: 0, saved: 0, coolingUntil: usage.coolingUntil };
  return usage;
}

function persistUsage() {
  save(USAGE_FILE, usage);
  emit({ type: "usage", usage: usageSummary() });
}

export function dailyLimit(model: string) {
  const { model: main, dailyLimit, fallbackDailyLimit } = config.gemini;
  return model === main ? dailyLimit : fallbackDailyLimit;
}

/** Can this model take a request now? Checks the local daily count and any rate-limit wait. */
export function modelAvailable(model: string) {
  const u = today();
  if ((u.coolingUntil[model] ?? 0) > Date.now()) return false;
  const limit = dailyLimit(model);
  return !limit || (u.calls[model] ?? 0) < limit;
}

export function recordCall(model: string) {
  const u = today();
  u.calls[model] = (u.calls[model] ?? 0) + 1;
  persistUsage();
}

export function coolDown(model: string, seconds: number) {
  today().coolingUntil[model] = Date.now() + seconds * 1000;
  persistUsage();
}

/** A request that never reached the AI: a cache hit, or an action the app handled itself. */
export function recordSaved(kind: "cache" | "shortcut") {
  const u = today();
  if (kind === "cache") u.cacheHits++;
  u.saved++;
  persistUsage();
}

export function usageSummary() {
  const u = today();
  const { model, fallbackModel } = config.gemini;
  const models = [model, ...(fallbackModel && fallbackModel !== model ? [fallbackModel] : [])];
  return {
    day: u.day,
    mode: config.llmMode,
    models: models.map((m) => ({
      model: m,
      calls: u.calls[m] ?? 0,
      limit: dailyLimit(m) || null,
      coolingUntil: (u.coolingUntil[m] ?? 0) > Date.now() ? u.coolingUntil[m] : null,
    })),
    saved: u.saved,
    cacheHits: u.cacheHits,
  };
}

// ---------- Response cache ----------

type CacheEntry = { message: ChatCompletionMessage; at: number };
let cache = load<Record<string, CacheEntry>>(CACHE_FILE, {});
const CACHE_MAX = 500;

export function cacheKey(payload: unknown) {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export function cacheGet(key: string): ChatCompletionMessage | undefined {
  if (!config.cacheHours) return undefined;
  const hit = cache[key];
  if (!hit) return undefined;
  if (Date.now() - hit.at > config.cacheHours * 3600_000) {
    delete cache[key];
    return undefined;
  }
  return hit.message;
}

export function cacheSet(key: string, message: ChatCompletionMessage) {
  if (!config.cacheHours) return;
  cache[key] = { message, at: Date.now() };
  const keys = Object.keys(cache);
  if (keys.length > CACHE_MAX) {
    keys.sort((a, b) => cache[a].at - cache[b].at).slice(0, keys.length - CACHE_MAX).forEach((k) => delete cache[k]);
  }
  save(CACHE_FILE, cache);
}

export function clearCache() {
  cache = {};
  save(CACHE_FILE, cache);
}
