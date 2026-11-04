import { PageRenderer } from "@mwf/render";
import { buildApp } from "./app.js";
import { openDatabase } from "./store.js";

const db = openDatabase(process.env.MWF_DB_PATH ?? "data/mwf.db");
// Pages are rendered in headless Chromium unless turned off; if it cannot start, pages that
// needed it get REVIEW (CTX.RENDER_FAILED), never a clean pass.
const sandbox = process.env.MWF_RENDER_SANDBOX !== "off";
if (!sandbox) console.warn("MWF_RENDER_SANDBOX=off: Chromium runs without its OS sandbox");
const renderer = process.env.MWF_RENDER === "off" ? undefined : new PageRenderer({ sandbox });
const app = buildApp({ db, ...(renderer && { render: (html: string) => renderer.render(html) }) });
const port = Number(process.env.PORT ?? 8787);

app.addHook("onClose", async () => renderer?.close());
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => void app.close().then(() => process.exit(0)));

await app.listen({ port, host: "127.0.0.1" });
console.log(`MWF firewall API listening on http://127.0.0.1:${port}${renderer ? "" : " (page rendering off)"}`);
