# Manual tasks — things only we can do

Code can't do these: they need an account, a browser login, a decision, or a person. Tick them off as we go. Owners are suggestions (R = Rajdeep, J = Jagrit).

## Now (blocks M0 / M6)

- [ ] **J + R — Create your own PayPal sandbox app.** [developer.paypal.com](https://developer.paypal.com) → Apps & Credentials → Sandbox → Create App. Copy the client ID and secret into **your own** `.env` (never chat, never git).
- [ ] **J + R — Enable Vault** on that sandbox app (app settings → advanced / features → Vault).
- [ ] **J + R — Note a sandbox personal (buyer) account** under Sandbox → Accounts. You'll log in with it once.
- [ ] **J — Run the Vault spike** (deadline **end of Nov 4**). The spike folder was removed on 2026-11-10; the sandbox run now goes through Errand (outside this repo). If Vault fails, we fall back to the sandbox test card.
- [ ] **J — M6 sandbox evidence run** (after the Vault spike): add `PAYPAL_PAYEE_EMAIL` (your sandbox app's business account email) to `.env`, then run the PayPal flow through Errand (outside this repo). Pass: one ALLOW captured, one BLOCK voided, sandbox ids only in the ledger.
- [x] **R — Check GitHub Actions is enabled.** Done: CI runs on every push (M0 run passed 2026-11-02).
- [ ] **R — Confirm the stack** recorded in [architecture.md §15](architecture.md#15-decisions-and-open-questions) (TypeScript + Fastify + Next.js + SQLite + Python sensors).

## Per developer, once

- [ ] **J + R — Install headless Chromium** for the page-visibility check: `npm run install-browser -w @mwf/render` (~100 MB). Without it the API holds every HTML page for REVIEW (`CTX.RENDER_FAILED`), and the render tests are skipped locally.

- [ ] **J + R — Make your own local MWF API key:** `npm run keys:create -- <your-name>`, put it in `.env` as `MWF_API_KEY`. Each of us has our own; nothing to share.
- [ ] **J + R — Register the demo merchant** for your tenant: `npm run merchants:add -- <your-name> shop-a "Shop A" <payee email>`. Use the **sandbox business account email** from PayPal so payee checks match what PayPal actually pays.
- [ ] **J + R — Set up a shared password-manager vault** (e.g. Bitwarden free, 2 users) for the one shared demo sandbox app's credentials, if we decide to have one.

## Decisions (before the milestone that needs them)

- [ ] **J + R — Pick the shopping agent's model** (needed by **M5, Nov 6**). Any model with tool calling. It is the attack victim, not part of the firewall. Whoever picks it gets an API key for it and adds the variable name to `.env.example`.
- [ ] **J + R — Review the M2 rules** in `packages/core/rules/bundle.json`: are any patterns likely to trip on real shop pages? Add a legit fixture for anything you worry about.
- [ ] **J + R — Review the seed fixtures** in `tests/fixtures/` (M1). Do the expected outcomes match what we'd defend to a judge? Especially: persuasion → REVIEW, and fake compliance within budget → BLOCK.
- [ ] **J + R — Agree thresholds** for REVIEW signals (classifier score, intent similarity) before M7.

## Later

- [ ] **J + R — Deploy the public demo** (decided 2026-11-11: Cloudflare Workers + Containers). One of us creates the Cloudflare account on the **Workers Paid** plan and invites the other under Members; then import the GitHub repo as a Worker with root directory `deploy/cloudflare`. Cloudflare builds the image, so no Docker is needed. Steps: [deploy/cloudflare/README.md](../deploy/cloudflare/README.md). Then put the URL in the README and on the submission form.
- [ ] **J — Record the demo video** and write the submission (M11, by Nov 15).
