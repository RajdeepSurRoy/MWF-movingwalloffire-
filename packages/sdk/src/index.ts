// What agents use to reach the firewall. Guard gives an agent its tools; FirewallClient is the
// API underneath, for businesses that wire the checkpoints up themselves.

export type { Decision } from "@mwf/core";
export * from "./client.js";
export * from "./guard.js";
export * from "./page.js";
