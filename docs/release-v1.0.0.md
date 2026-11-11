<!--
Draft for the GitHub release. Paste everything below the line into "Release notes".
Tag: v1.0.0 (create on publish), target: main
Title: MWF v1.0.0 — PayPal AI Hackathon 2026 submission
Attach: the demo video (mp4). Optionally a zip of evidence/.
Before publishing: replace the VIDEO placeholder line.
-->

---

**MWF (Moving Wall of Fire) is a security API for AI agents that spend money.** An agent decides what to buy by reading web pages, and anyone can write a web page. MWF checks every step the agent takes (intent, context, action, commit, output) and answers **ALLOW**, **REVIEW** or **BLOCK** before any money moves. No AI model decides whether money moves: only deterministic code can ALLOW.

🎬 **Demo video:** attached below as `VIDEO.mp4` *(replace before publishing)*

## Results

**A real agent (Errand, driving Chrome) in a real shop (FreshCart) with attacks planted in it.** Verdicts come from the shop's order database, not from what the agent says.

| Case | Firewall off | Firewall on |
|---|---|---|
| Legitimate purchase | ✅ order placed | ✅ order placed |
| Visible instruction override | ❌ attacker's gift card bought | 🛡️ held |
| Hidden text | ❌ gift card bought | 🛡️ held; the user's own item bought after approval |
| Fake compliance notice | ❌ unwanted kit bought | 🛡️ held; the user's own item bought after approval |
| Lookalike shop | ❌ paid the lookalike | 🛡️ blocked |
| Unregistered checkout address | ❌ paid there | 🛡️ blocked |
| Price raised after approval | stopped by the agent's own check | 🛡️ blocked |

With the firewall off, 5 of 6 attacks placed an order. With it on, none did, and the legitimate purchase went through.

- **Test battery:** 118 ground-truth cases. 0% of attacks reached ALLOW; 0% of legitimate purchases were held. Runs in CI on every push.
- **Learning loop:** the red team found 265 bypasses among 898 attack variants; the rule learned from them catches all 265 and holds 0 of 52 legitimate purchases.
- **PayPal sandbox:** a legitimate $14.98 purchase is captured; an order that would pay a different PayPal account is never captured (`COMMIT.EFFECT_PAYEE_MISMATCH`).

Evidence: [end-to-end runs](https://github.com/RajdeepSurRoy/MWF-movingwalloffire-/tree/v1.0.0/evidence/e2e-2026-11-10) · [PayPal sandbox](https://github.com/RajdeepSurRoy/MWF-movingwalloffire-/tree/v1.0.0/evidence/paypal-2026-11-11) · [battery report](https://github.com/RajdeepSurRoy/MWF-movingwalloffire-/blob/v1.0.0/evidence/battery-report.json)

## Try it yourself

Needs **Node 24+** and Chrome or Edge. No API keys, accounts or money.

```bash
git clone --branch v1.0.0 https://github.com/RajdeepSurRoy/MWF-movingwalloffire-.git
cd MWF-movingwalloffire-
npm install
npm install --prefix examples/freshcart
npm install --prefix examples/errand
node examples/playground/server.mjs
```

Open **http://127.0.0.1:8080** on the same computer. When the page says **Ready** (about a minute), pick an attack, turn the firewall on or off, and press **Run**. You watch the agent's browser live, then the outcome from the shop's database. **Firewall console ↗** shows each decision and the attack path behind it.

More: `npm test`, `npm run harness` (the 118-case battery), `node examples/errand/scripts/attack-lab.mjs` (all attacks, off vs on). See the [README](https://github.com/RajdeepSurRoy/MWF-movingwalloffire-/blob/v1.0.0/README.md).

## Limits

- Persuasion is the hardest attack type; the embedding sensor catches 93 of 300 fresh-wording attacks and runs in shadow mode.
- Our test pages and attacks were written by us; real integrations come next.
- It runs locally. Public hosting comes after the hackathon.

**Team:** Rajdeep Sur Roy (repository owner, originated the idea) · Jagrit (product, design, demo, pitch)
