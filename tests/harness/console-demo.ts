// Console demo: the firewall API with the console, on a fresh local database, with fixture
// purchases and attacks replayed through it one by one so the live feed fills up as you watch.
//
//   npm run console:demo -- [--port 8787] [--key-file <path>] [--delay 1500] [--render]
//
// It creates a local demo tenant and key. The key is written to --key-file (default
// data/console-demo.key, gitignored) and never printed. Open http://127.0.0.1:<port>/console and
// paste it. Nothing here touches PayPal or any outside system.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { type TestCase, getDefaultBundle, sensorTexts } from "@mwf/core";
import { type Embed, buildApp, createApiKey, openDatabase, upsertMerchant } from "@mwf/firewall-api";
import { loadCases, loadMerchants } from "./harness.js";

const args = process.argv.slice(2);
const flag = (n: string, d: string) => (args.includes(n) ? args[args.indexOf(n) + 1]! : d);
const port = Number(flag("--port", "8787"));
const delay = Number(flag("--delay", "1500"));
const keyFile = resolve(flag("--key-file", resolve(import.meta.dirname, "../../data/console-demo.key")));
const TENANT = "demo";

const db = openDatabase(":memory:");
for (const m of loadMerchants()) upsertMerchant(db, TENANT, m);
const { key } = createApiKey(db, TENANT, "console demo");
mkdirSync(dirname(keyFile), { recursive: true });
writeFileSync(keyFile, key + "\n", { mode: 0o600 });

const bundle = getDefaultBundle();
let embed: Embed | undefined;
if (bundle.claim_sensors.length) {
  const { SensorCache, loadEmbedder } = await import("@mwf/sensors");
  const cache = new SensorCache(await loadEmbedder(bundle.claim_sensors[0]!.model));
  embed = (t) => cache.vectors(t);
}
let render;
if (args.includes("--render")) {
  const { PageRenderer } = await import("@mwf/render");
  const r = new PageRenderer();
  render = (item: Parameters<typeof r.renderItem>[0]) => r.renderItem(item);
}
const app = buildApp({ db, bundle, ...(embed && { embed }), ...(render && { render }) });
await app.listen({ port, host: "127.0.0.1" });
console.log(`Console: http://127.0.0.1:${port}/console  (key in ${keyFile})`);

// A mix the audience can follow: purchases that go through, then each kind of attack.
const all = loadCases();
const pick = (cat: string, n: number) => all.filter((c) => c.category === cat).slice(0, n);
const script: TestCase[] = [
  ...pick("legit", 3),
  ...pick("hidden_text", 1),
  ...pick("legit", 5).slice(3),
  ...pick("persuasion", 2),
  ...pick("lookalike_merchant", 1),
  ...pick("direct_override", 1),
  ...pick("fake_compliance", 1),
  ...pick("transaction_modification", 1),
];
const headers = { authorization: `Bearer ${key}` };
const post = async (url: string, payload: unknown) => (await app.inject({ method: "POST", url, headers, payload: payload as object })).json();
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

await sleep(delay * 2);
for (const c of script) {
  const s = await post("/v1/sessions", { prompt: c.mandate.intent_text, mandate: c.mandate });
  await post("/v1/context/inspect", { session_id: s.session_id, items: c.context });
  const check = await post("/v1/actions/check", { session_id: s.session_id, action: c.action });
  // The executed action, for attacks that change it after approval.
  if (check.action_token) {
    await post("/v1/actions/commit", { session_id: s.session_id, action_token: check.action_token, action: c.commit_action ?? c.action });
  }
  console.log(`${c.id.padEnd(28)} ${check.decision}${sensorTexts(c, bundle).length ? " (claim scored)" : ""}`);
  await sleep(delay);
}
console.log("Replay done; the console stays up. Ctrl+C to stop.");
