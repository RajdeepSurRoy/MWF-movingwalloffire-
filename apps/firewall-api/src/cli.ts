// Local admin commands for the firewall's own database.
//   npm run keys:create -- <tenant> [label]   prints a new API key once
//   npm run ledger:verify                     walks the hash chain
import { Ledger } from "@mwf/core";
import { createApiKey } from "./auth.js";
import { openDatabase } from "./store.js";

const [command, ...args] = process.argv.slice(2);
const db = openDatabase(process.env.MWF_DB_PATH ?? "data/mwf.db");

if (command === "keys:create") {
  const [tenant, label = "local dev"] = args;
  if (!tenant || !/^[a-z0-9-]{1,64}$/.test(tenant)) {
    console.error("Usage: npm run keys:create -- <tenant-id> [label]   (tenant: lowercase letters, digits, dashes)");
    process.exit(1);
  }
  const { key } = createApiKey(db, tenant, label);
  console.log(`API key for tenant "${tenant}" (shown once; only its hash is stored):\n\n  ${key}\n`);
  console.log("Put it in your .env as MWF_API_KEY. Do not commit or paste it in chat.");
} else if (command === "ledger:verify") {
  const result = new Ledger(db).verify();
  if (result.ok) {
    console.log(`✔ ledger intact: ${result.entries} entries`);
  } else {
    console.error(`✖ ledger broken at entry ${result.brokenAt}: ${result.problem}`);
    process.exit(1);
  }
} else {
  console.error("Usage: cli.ts <keys:create|ledger:verify>");
  process.exit(1);
}
