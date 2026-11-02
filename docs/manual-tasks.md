# Manual tasks — things only we can do

Code can't do these: they need an account, a browser login, a decision, or a person. Tick them off as we go. Owners are suggestions (R = Rajdeep, J = Jagrit).

## Now (blocks M0 / M6)

- [ ] **J + R — Create your own PayPal sandbox app.** [developer.paypal.com](https://developer.paypal.com) → Apps & Credentials → Sandbox → Create App. Copy the client ID and secret into **your own** `.env` (never chat, never git).
- [ ] **J + R — Enable Vault** on that sandbox app (app settings → advanced / features → Vault).
- [ ] **J + R — Note a sandbox personal (buyer) account** under Sandbox → Accounts. You'll log in with it once.
- [ ] **J — Run the Vault spike** (deadline **end of Nov 4**). Steps in [spikes/paypal-vault/README.md](../spikes/paypal-vault/README.md): `setup` → approve the link in the browser with the sandbox buyer → `token` → `run`. Paste the final "Spike passed" line (not the IDs) in the team chat. If it fails, we fall back to the sandbox test card.
- [x] **R — Check GitHub Actions is enabled.** Done: CI runs on every push (M0 run passed 2026-11-02).
- [ ] **R — Confirm the stack** recorded in [architecture.md §15](architecture.md#15-decisions-and-open-questions) (TypeScript + Fastify + Next.js + SQLite + Python sensors).

## Per developer, once

- [ ] **J + R — Make your own local MWF API key:** `npm run keys:create -- <your-name>`, put it in `.env` as `MWF_API_KEY`. Each of us has our own; nothing to share.
- [ ] **J + R — Set up a shared password-manager vault** (e.g. Bitwarden free, 2 users) for the one shared demo sandbox app's credentials, if we decide to have one.

## Decisions (before the milestone that needs them)

- [ ] **J + R — Pick the shopping agent's model** (needed by **M5, Nov 6**). Any model with tool calling. It is the attack victim, not part of the firewall. Whoever picks it gets an API key for it and adds the variable name to `.env.example`.
- [ ] **J + R — Review the seed fixtures** in `tests/fixtures/` (M1). Do the expected outcomes match what we'd defend to a judge? Especially: persuasion → REVIEW, and fake compliance within budget → BLOCK.
- [ ] **J + R — Agree thresholds** for REVIEW signals (classifier score, intent similarity) before M7.

## Later

- [ ] **R — Deploy** around **Nov 9** (M6): firewall API on Railway / Render / Fly (needs a persistent disk for SQLite), shop + console on Vercel. Set env vars in each host's dashboard.
- [ ] **R — Register the sandbox webhook** against the deployed URL (or a cloudflared / ngrok tunnel before that) and put its ID in `PAYPAL_WEBHOOK_ID`.
- [ ] **J — Record the demo video** and write the submission (M11, by Nov 15).
