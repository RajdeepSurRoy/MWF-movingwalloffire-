import { getDefaultBundle } from "@mwf/core";
import { PageRenderer } from "@mwf/render";
import { SensorCache, loadEmbedder } from "@mwf/sensors";
import { type Embed, buildApp } from "./app.js";
import { openDatabase } from "./store.js";

const db = openDatabase(process.env.MWF_DB_PATH ?? "data/mwf.db");
// Pages are rendered in headless Chromium unless turned off; if it cannot start, pages that
// needed it get REVIEW (CTX.RENDER_FAILED), never a clean pass.
const sandbox = process.env.MWF_RENDER_SANDBOX !== "off";
if (!sandbox) console.warn("MWF_RENDER_SANDBOX=off: Chromium runs without its OS sandbox");
const renderer = process.env.MWF_RENDER === "off" ? undefined : new PageRenderer({ sandbox });
// Embedding sensors, when the rule bundle has any. If the model cannot load, claims about bought
// items are held for REVIEW by the enforced sensors (SEN.UNAVAILABLE), never passed unscored.
const bundle = getDefaultBundle();
let embed: Embed | undefined;
if (bundle.claim_sensors.length > 0) {
  try {
    const cache = new SensorCache(await loadEmbedder(bundle.claim_sensors[0]!.model));
    embed = (texts) => cache.vectors(texts, Number(process.env.MWF_SENSOR_TIMEOUT_MS ?? 2000));
  } catch (e) {
    console.warn(`Embedding model not loaded (${(e as Error).message}); sensor-scored claims will be held for REVIEW`);
  }
}
const app = buildApp({ db, bundle, ...(renderer && { render: (item) => renderer.renderItem(item) }), ...(embed && { embed }) });
const port = Number(process.env.PORT ?? 8787);

app.addHook("onClose", async () => renderer?.close());
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => void app.close().then(() => process.exit(0)));

await app.listen({ port, host: "127.0.0.1" });
console.log(`MWF firewall API listening on http://127.0.0.1:${port}${renderer ? "" : " (page rendering off)"}`);
