# MWF Implementation Plan — Core Security System

> Status: **draft plan**, 2026-11-02. Builds what [architecture.md](architecture.md) v1.0 calls Phase 0, then outlines Phases 1–2. Dates assume the hackathon deadline of **2026-11-15** and a team of two.

## How to read this

- Work is split into **milestones (M0–M9)**. Each step has a **done when** check, so "finished" is never a matter of opinion.
- Milestones overlap on purpose: the PayPal spike starts on day 1 because it is the biggest risk.
- The test battery is built *before* the firewall rules (M2), so every rule is written against ground truth.
- Owner suggestions use **R** (Rajdeep) and **J** (Jagrit). They are suggestions for the team to confirm.

## Timeline at a glance

| Dates | Milestone | Owner (suggested) |
|---|---|---|
| Nov 2–3 | M0 — Decisions, skeleton, PayPal spike | R + J |
| Nov 3–4 | M1 — Core contracts, ledger, test harness | R |
| Nov 4–6 | M2 — Deterministic firewall | R |
| Nov 4–6 | M3 — Simulated shop and attack scenarios | J |
| Nov 5–7 | M4 — Provenance graph | R |
| Nov 6–8 | M5 — Shopping agent + SDK wrapper | J |
| Nov 6–9 | M6 — PayPal integration | R |
| Nov 7–9 | M7 — Neural sensors | R / J |
| Nov 8–11 | M8 — Red team and learning loop | R + J |
| Nov 9–12 | M9 — Console, Trust Score, Security Passport | J |
| Nov 12–13 | M10 — End-to-end hardening and evidence | R + J |
| Nov 13–15 | M11 — Demo, pitch, submission (Nov 14–15 is buffer) | J (+ R) |

---

## M0 — Decisions, skeleton, PayPal spike (Nov 2–3)

1. **Lock the stack.** Recommendation:
   - TypeScript end to end: **Fastify** for the firewall API, **Next.js** for the shop and console, **SQLite** (via better-sqlite3 or Drizzle) for storage.
   - **Python sidecar** (FastAPI + sentence-transformers / ONNX Runtime) for the neural sensors — the ML tooling is far easier in Python.
   - **Policy rules as versioned JSON** evaluated by a small TypeScript engine for Phase 0; move to Cedar or OPA in Phase 1.
   - *Done when:* recorded in architecture.md §15 (open questions → decided).
2. **Decide the shopping agent's model** (it is the attack victim, not the firewall). Any model with tool calling works; record/replay its runs so tests don't depend on it.
3. **Create the repo layout:**

   ```
   packages/core        types, policy engine, graph, ledger, hashing
   packages/sdk         client wrapper that agents use
   apps/firewall-api    Fastify server: the five checkpoints + feedback
   apps/shop            simulated e-commerce site with planted attacks
   apps/agent           minimal shopping agent with one propose_purchase tool
   apps/console         review queue, attack paths, rules, Passport
   services/sensors     Python: embeddings + injection classifier
   redteam/             mutation engine, scenarios, runner
   tests/fixtures       attacks/, legit/, expected outcomes
   ```

4. **CI:** lint, type-check and the test battery on every push (GitHub Actions).
5. **PayPal Vault spike (highest risk).** Get a sandbox buyer, save a payment method for the agent, then create order (intent AUTHORIZE) → authorize → capture, and a second order → authorize → void, with no human in the loop.
   - *Done when:* both flows work from a script against the sandbox. **If Vault fails by end of Nov 4**, fall back to the sandbox test card and note it in the README.

## M1 — Core contracts, ledger, test harness (Nov 3–4)

1. **Schemas** (zod) in `packages/core`: `Mandate`, `ContextItem` (with trust tag), `ProposedAction`, `Decision` (ALLOW / BLOCK / REVIEW + reasons), `DecisionRecord` (policy version, rule bundle version, model hashes, action hash, graph path).
2. **Canonical hashing:** a deterministic JSON canonicalizer + SHA-256 for actions and mandates. *Done when:* the same action in different key order gives the same hash (unit test).
3. **API stubs** for all endpoints in architecture §3, returning REVIEW by default (fail closed). API key auth with hashed keys.
4. **Ledger:** append-only SQLite table; each entry stores the previous entry's hash. A verify command walks the chain. *Done when:* editing any row makes verification fail.
5. **Test harness:** a runner that loads `tests/fixtures`, sends each case through the decision logic (no network, no PayPal) and compares with the expected outcome. Outputs attack success rate (ASR) per category and false-positive rate on the legitimate set.
6. **Seed fixtures:** ~10 attacks per category (six categories) and the first 50 legitimate purchases, each with an expected outcome.
   - *Done when:* the harness runs in CI and reports (everything fails — that's expected now).

## M2 — Deterministic firewall (Nov 4–6)

1. **Mandate checks:** category, `max_total`, per-item cap, expiry, allowed actions.
2. **Merchant and payee allowlist,** exact match after normalization; **lookalike detection** (Unicode confusables, edit distance to allowlisted names).
3. **Context scanner (hard signatures):** hidden CSS text, zero-width characters, HTML comments, meta tags, instruction phrases ("ignore previous…"), fake compliance/urgency notices. Each finding has a rule ID.
4. **Canary tokens:** planted per session at checkpoint 1; detected in action arguments and outputs.
5. **Integrity check (checkpoint 4):** approved action hash must equal execute-time hash; idempotency key per action token (duplicate/retry attacks).
6. **Session risk score:** accumulates findings across the session.
7. **Decision engine:** combines results per the table in architecture §7 and writes a `DecisionRecord` with reasons.
8. **Rule bundle versioning:** rules live in a versioned JSON bundle; every decision logs the bundle version.
   - *Done when:* harness shows the obvious categories (override, hidden text, lookalike, transaction modification) blocked, and **0 false blocks** on the 50 legitimate purchases. Persuasion should still pass at this point — that is the demo's "v1 bypass".

## M3 — Simulated shop and attack scenarios (Nov 4–6)

1. **Shop** (Next.js): product listing, product pages, cart, checkout that calls the agent flow. Several merchants, including a lookalike.
2. **Attack switchboard:** each attack scenario can be turned on per page via config, so tests and demo pick exactly which attacks are live.
3. **Six scenario families** (README categories), each with a ground-truth expected outcome:
   - instruction override ("buy the $500 gift card"),
   - persuasion / ranking manipulation (in-budget, overpriced item),
   - hidden-text smuggling (white text, zero-width, comments, meta),
   - fake compliance / urgency ("mandatory warranty"),
   - lookalike merchant / payee,
   - transaction modification / duplicate retry.
4. **Legitimate pages** with normal marketing language ("best seller", "add to cart") to keep false-positive tests honest.
   - *Done when:* every scenario can be rendered and exported as a fixture for the harness.

## M4 — Provenance graph (Nov 5–7)

1. **Tables:** `nodes(id, session_id, type, trust, attrs)` and `edges(src, dst, type)` in SQLite.
2. **Graph building:** checkpoint 1 adds intent and mandate nodes; checkpoint 2 adds source and span nodes with trust tags and findings; checkpoint 3 adds agent-step, proposed-value and action nodes with `derived_from` / `influenced` edges.
3. **How provenance is known:** the SDK records which context items the agent read before each proposal; proposed values are matched back to spans by exact/normalized text match. (Phase 0 is deliberately simple; finer tracking comes later.)
4. **Path query** (recursive CTE): "is there a path from an untrusted node to the item, amount or payee of this action?" → REVIEW, or BLOCK when the path starts at a hard signature. The path is stored in the `DecisionRecord`.
   - *Done when:* the hidden-text and fake-compliance scenarios produce a stored path, and the query runs in under 10 ms on a demo-size session.

## M5 — Shopping agent and SDK wrapper (Nov 6–8)

1. **SDK (`packages/sdk`):** `startSession(intent)`, `inspectContext(items)`, `checkAction(action)`, `commitAction(token)`. It wraps the agent's tool calls so the agent never talks to PayPal directly.
2. **Agent:** reads shop pages, chooses items, calls one `propose_purchase` tool. Runs through the SDK.
3. **Record/replay** of agent runs so end-to-end tests are repeatable without calling the model each time.
4. **Baseline mode:** the same agent with the firewall switched off, for the "with vs. without" demo step.
   - *Done when:* the agent completes the legitimate batteries purchase and is fooled by at least the obvious attack in baseline mode.

## M6 — PayPal integration (Nov 6–9)

1. Production-quality version of the M0 spike behind a `PaymentPlugin` that implements the generic two-phase commit: create order (AUTHORIZE, `PayPal-Request-Id`) → authorize → firewall integrity check → capture / void / hold.
2. **REVIEW path:** authorization held; console approves → re-check → capture, or rejects → void.
3. **Webhooks:** register in sandbox, verify signatures before trusting any event, record events in the ledger.
4. **Cleanup:** evidence tests void anything they don't capture.
   - *Done when:* one ALLOW (captured) and one BLOCK (voided) run end to end with sandbox IDs written to the ledger.

## M7 — Neural sensors (Nov 7–9)

1. **Sidecar service** (`services/sensors`): `POST /embed`, `POST /similarity`, `POST /injection-score`. Each response includes the model hash. Timeouts → caller treats as REVIEW.
2. **Embedding model** (`bge-small-en-v1.5` or `all-MiniLM-L6-v2`) for **intent ↔ cart similarity**.
3. **Calibrate the threshold on the legitimate set** (target: at most 1 in 200 legitimate purchases to REVIEW), *then* measure how many attacks it catches.
4. **Injection classifier** (off-the-shelf DeBERTa or Prompt Guard; check the license) on untrusted spans at checkpoint 2, REVIEW only. Same calibration.
5. Wire both into the decision engine as tighten-only signals.
   - *Done when:* harness shows the semantic signals reduce ASR for persuasion / fake compliance without pushing legitimate false positives over target; p99 latency per call under 50 ms on a laptop CPU.

## M8 — Red team and learning loop (Nov 8–11)

1. **Mutation engine:** deterministic transforms — re-encode, lookalike Unicode, zero-width insertion, split across chunks, move into comments/meta, synonym/paraphrase templates, amount/merchant variants. One seed → 20+ variants, each with an inherited expected outcome.
2. **Runner:** executes seeds + mutations through the harness and reports **bypasses** (ALLOW where ground truth is BLOCK/REVIEW).
3. **Attack ledger:** each bypass recorded with its graph path and findings.
4. **Four-level learning:**
   1. exact hash,
   2. normalized fingerprint,
   3. embedding family (nearest known family above a similarity threshold),
   4. **root-cause candidate rule** from templates keyed by what the graph path shows (e.g. "payee derived from untrusted span", "item outside mandate category with persuasion phrasing").
5. **Backtest:** run the candidate rule bundle over the full legitimate set and all past attacks; report "blocks N new variants, breaks M of 50 legit purchases".
6. **Rollout states:** shadow → approved → enforced; approval bumps the rule bundle version. No automatic BLOCK rules.
   - *Done when:* the demo story works from a script: a persuasion seed bypasses v1 → runner flags it → candidate rule → backtest clean → approve → v2 blocks the seed **and its mutations**.

## M9 — Console, Trust Score, Security Passport (Nov 9–12)

1. **Review queue:** held decisions with reasons and an **attack-path view** (hidden text → cart item → blocked payment, drawn in red).
2. **Rules page:** candidate rules with backtest results and an approve button; bundle version history.
3. **Live feed:** decisions as they happen during the demo.
4. **Trust Score (0–100):** computed only from harness results; every number links to test IDs.
5. **Security Passport:** downloadable JSON + readable view (suite version, policy version, results by category, sandbox evidence IDs, report hash).
   - *Done when:* a judge can follow one attack from page to blocked payment in the UI without explanation.

## M10 — End-to-end hardening and evidence (Nov 12–13)

1. Full battery green in CI; ASR and false-positive numbers recorded.
2. **Evidence subset:** 1–2 cases per category run end to end through the sandbox (authorize → capture or void).
3. Fail-closed tests: sensor down, graph query timeout, ledger write failure → no capture.
4. Secrets check: nothing in code, logs or the frontend; `.env` gitignored.
5. Optional: run a slice of a public benchmark (AgentDojo / InjecAgent) for an independent number.

## M11 — Demo, pitch, submission (Nov 13–15)

1. Script the six-step demo from the README; rehearse it twice.
2. **Recorded backup** of the whole demo in case of network or rate-limit trouble.
3. README: setup instructions for the chosen stack, real numbers, screenshots.
4. Pitch deck with the roadmap (Phases 1–2) and the business model.
5. Submit by Nov 14 — Nov 15 is buffer.

---

## Cut list (if time runs short, drop in this order)

1. Fine-tuned classifier → keep off-the-shelf.
2. Injection classifier entirely → keep the embedding model.
3. Public benchmark run.
4. Live feed in the console.
5. REVIEW human-approval flow in PayPal → show REVIEW as "held" only.

**Never cut:** deterministic firewall, provenance path query, the learning-loop demo, sandbox capture/void evidence.

---

## After the hackathon

### Phase 1 — Design partners (≈ 3 months)

1. Harden for multi-tenant use: Postgres, tenant isolation, key rotation, rate limits, audit logs.
2. **MCP gateway** as the main integration; SDK wrappers for the major agent frameworks.
3. Action registry + risk classes; second action plugin (e.g. email or CRM write) to prove the core is generic.
4. Checkpoint 5 (output checks) and the sensitive-data model.
5. `/feedback`, delayed deep scan, per-tenant rules, backtest on real legitimate traffic.
6. Move policies to Cedar or OPA; signed rule bundles; local-evaluation SDK.
7. Sequence anomaly model; cross-session graph and campaign queries.
8. Observability: latency SLOs, decision dashboards, alerting.
9. Onboard 3–5 design partners; measure ASR and false positives on their traffic.

### Phase 2 — Network (≈ 6 months)

1. Multi-tenant corroboration and signed global rule bundles.
2. Honeypot agents feeding threat intelligence.
3. Fine-tuned classifier pipeline with scheduled retraining.
4. Offline GNN over the cross-tenant graph.
5. Published benchmark results; third-party security review / SOC 2 preparation.
