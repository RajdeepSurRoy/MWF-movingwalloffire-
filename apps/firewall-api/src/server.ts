import { buildApp } from "./app.js";
import { openDatabase } from "./store.js";

const db = openDatabase(process.env.MWF_DB_PATH ?? "data/mwf.db");
const app = buildApp({ db });
const port = Number(process.env.PORT ?? 8787);

await app.listen({ port, host: "127.0.0.1" });
console.log(`MWF firewall API listening on http://127.0.0.1:${port}`);
