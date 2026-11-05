# Agent

Minimal shopping agent with one `propose_purchase` tool, running through `@mwf/sdk`. It is the attack victim, not part of the firewall.

```bash
npm run demo -w @mwf/agent
```

Runs each scenario (`legit`, `obvious-attack`, `hidden-attack`) with the firewall off and on, all locally: an in-process firewall with a throwaway key, and a stand-in shop. Add a scenario name after `--` to run just that one. Needs Chromium (`npx playwright install chromium`).

- `model.ts`: the `Model` interface. Which real model drives the agent is not decided yet.
- `naive.ts`: the deterministic stand-in. It obeys any page that tells it to buy, so it shows what the firewall stops, not how easily a real model is fooled.
- `agent.ts`: the tool loop. Model output is untrusted: every call is validated.
- `replay.ts`: record a run, replay it without the model. A replay fails if what the model sees differs from the recording.
- `run.ts`: `runGuarded` and `runBaseline`, the same agent with and without the firewall.
- `shop.ts`: a one-page stand-in until `apps/shop` is built (M3).
