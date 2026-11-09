// For running the firewall inside another process: the agent's local demo and end-to-end tests.
export { type Embed, type Render, buildApp } from "./app.js";
export { createApiKey } from "./auth.js";
export { openDatabase, upsertMerchant } from "./store.js";
