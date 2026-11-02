import { buildApp } from "./app.js";

const port = Number(process.env.PORT ?? 8787);
const app = buildApp();

await app.listen({ port, host: "127.0.0.1" });
console.log(`firewall-api listening on http://127.0.0.1:${port}`);
