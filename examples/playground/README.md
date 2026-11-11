# MWF Playground

A public page for trying MWF without installing anything. Pick an attack to plant in FreshCart and choose whether MWF checks Errand, then press Run. You watch the agent's real browser, the firewall's decisions and the outcome. As in the [attack lab](../errand/scripts/attack-lab.mjs), the outcome comes from the shop's order database, not from what the agent says. Both share [lab-core.mjs](../errand/scripts/lab-core.mjs).

Built for a public demo:

- **One run at a time.** The queue holds up to 6 runs. Each visitor can have one run waiting, and start at most 12 runs an hour.
- **No AI key and no money.** The agent uses Errand's offline `naive` model, which always obeys instructions planted in shop text, so every attack is really attempted. Checkout uses pay-on-delivery.
- **The read-only console is included.** `/console` is proxied with the demo tenant's key added on the server. The key never reaches the browser, and only the console's read endpoints are passed through.
- **The page treats everything as text.** Agent messages quote attacker-written pages, so they are never inserted as HTML.

## Run it locally

You need Node 24 and Chrome or Edge, as for the attack lab:

```bash
npm install                          # in the repo root
npm install --prefix examples/freshcart
npm install --prefix examples/errand
node examples/playground/server.mjs
```

Open http://127.0.0.1:8080. The page reads "Starting…" until the firewall and the shop are up, which takes about a minute.

| Setting | Default | |
|---|---|---|
| `PORT`, `HOST` | `8080`, `127.0.0.1` | The container uses `0.0.0.0` |
| `SHOP_MODE` | `dev` | `start` serves a production build (run `npx next build` in `examples/freshcart` first) |
| `DATA_DIR` | a new temp folder | Where the firewall and shop databases go |
| `TRUST_CF_IP` | off | `1` only behind Cloudflare (the Worker sets it): rate-limit by `CF-Connecting-IP`. Never set it where clients reach the server directly; they could fake the header |

It uses ports 8787 (firewall), 3100 (shop) and 3101 (lookalike shop) internally, the same as the attack lab, so don't run both at once.

Deploying it publicly: [deploy/cloudflare](../../deploy/cloudflare).
