import express from "express";
import { z } from "zod";
import { config } from "./config.js";
import { closeBrowser } from "./browser.js";
import { subscribe, setStatus } from "./events.js";
import * as agent from "./agent.js";
import { getProfile, saveProfile } from "./profile.js";
import { DELIVERY_SLOTS, readCatalog } from "./store.js";
import { usageSummary } from "./usage.js";
import { walletInfo } from "./wallet.js";

const app = express();
app.use(express.json({ limit: "32kb" }));
app.use(express.static("public"));

/** Live updates: chat, status, browser steps and screenshots. */
app.get("/api/events", (_req, res) => subscribe(res));

app.get("/api/info", (_req, res) => {
  res.json({
    storeUrl: config.storeUrl,
    model: config.gemini.model,
    hasApiKey: !!config.gemini.apiKey,
    deliverySlots: DELIVERY_SLOTS,
    profile: getProfile(),
    payments: agent.payments,
    usage: usageSummary(),
    wallet: walletInfo(),
  });
});

// The agent works in the background; progress arrives over /api/events.
function runInBackground(res: express.Response, work: () => Promise<unknown>) {
  if (agent.isBusy()) return res.status(409).json({ error: "The agent is still working on your last request." });
  work().catch((error) => {
    console.error(error);
    setStatus("error", error instanceof Error ? error.message : "Something went wrong");
  });
  res.status(202).json({ ok: true });
}

app.post("/api/chat", (req, res) => {
  const parsed = z.object({ text: z.string().trim().min(1).max(1000) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Type a message first." });
  runInBackground(res, () => agent.handleUserMessage(parsed.data.text));
});

app.post("/api/cart/add", (req, res) => {
  const parsed = z.object({ sku: z.string().trim().min(3).max(40) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Missing product code." });
  runInBackground(res, () => agent.quickAdd(parsed.data.sku));
});

app.post("/api/payments/:id/approve", (req, res) => {
  runInBackground(res, () => agent.approvePayment(req.params.id));
});

app.post("/api/payments/:id/decline", (req, res) => {
  try {
    agent.declinePayment(req.params.id);
    res.json({ ok: true });
  } catch (error) {
    res.status(409).json({ error: error instanceof Error ? error.message : "Not active" });
  }
});

app.put("/api/profile", (req, res) => {
  try {
    res.json({ profile: saveProfile(req.body) });
  } catch (error) {
    const message = error instanceof z.ZodError ? error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : "Invalid profile";
    res.status(400).json({ error: message });
  }
});

app.post("/api/reset", async (_req, res) => {
  if (agent.isBusy()) return res.status(409).json({ error: "Wait for the agent to finish first." });
  await agent.resetSession();
  res.json({ ok: true });
});

const server = app.listen(config.port, () => {
  console.log(`Errand agent:  http://localhost:${config.port}`);
  console.log(`Shopping at:   ${config.storeUrl}`);
  console.log(
    config.llmMode !== "gemini"
      ? `AI:            offline ${config.llmMode} stand-in (AGENT_LLM=${config.llmMode}), no API calls`
      : `Gemini model:  ${config.gemini.model}${config.gemini.apiKey ? "" : "  (GEMINI_API_KEY not set!)"}`,
  );
  // Read the store's aisles up front (no AI involved), so the first request is quick and cheap.
  if (config.prefetchCatalog || config.llmMode !== "gemini") {
    readCatalog().catch(() => console.warn(`Couldn't read the store at ${config.storeUrl} yet. Is FreshCart running?`));
  }
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    server.close();
    await closeBrowser();
    process.exit(0);
  });
}
