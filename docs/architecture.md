# MWF Security Architecture

> Status: **final design, v1.0** (agreed 2026-11-02). Nothing here is implemented yet. Where this document and the README disagree, this document wins. Changes from here on go through a pull request that updates this file.

## Contents

1. [What we are building](#1-what-we-are-building)
2. [Principles](#2-principles)
3. [Five checkpoints, from prompt to output](#3-five-checkpoints-from-prompt-to-output)
4. [The three firewalls](#4-the-three-firewalls)
5. [Neural components](#5-neural-components)
6. [Provenance graph: attack points and attack linkage](#6-provenance-graph-attack-points-and-attack-linkage)
7. [How a decision is made](#7-how-a-decision-is-made)
8. [Learning from every attack](#8-learning-from-every-attack)
9. [Global protection across customers](#9-global-protection-across-customers)
10. [Covering all agentic work](#10-covering-all-agentic-work)
11. [Securing MWF itself](#11-securing-mwf-itself)
12. [How we measure it](#12-how-we-measure-it)
13. [Build phases](#13-build-phases)
14. [Rejected alternatives](#14-rejected-alternatives)
15. [Open questions](#15-open-questions)

---

## 1. What we are building

A security layer that businesses get through an **API key** to protect their AI agents — from the moment a user gives a prompt to the final output. Payments (PayPal) are the first thing it protects; the design is general so every agentic workflow can follow.

The plan has three stages:

1. **Stress test in simulation.** A simulated third-party e-commerce site and a shopping agent. We plant attacks; the security layer sees them.
2. **Block and learn.** The firewall blocks known attack patterns. When an attack gets through, the red team identifies it, the firewall learns it, and similar future attacks are blocked.
3. **Learn live, protect globally.** The same loop runs on real customer traffic. An attack one business meets is learned and protects every other business.

## 2. Principles

1. **Cryptography proves an action was executed correctly; it can't prove the decision was right.** So every action is checked against what the user actually asked for.
2. **Only deterministic code can say ALLOW.** Neural networks are sensors: they can make a decision stricter, never looser, and a model score alone never causes a BLOCK.
3. **No generative LLM in the firewall.** No model writes text or decides. Nothing is sent to a third-party AI provider.
4. **Structure beats detection.** Least privilege, provenance tracking and two-phase commit close whole classes of attack. Detection is an arms race; it is the second line.
5. **Fail closed.** If the firewall can't decide in time, the action doesn't happen.
6. **Nothing loosens automatically.** Tightening can be automated within limits; loosening, BLOCK rules and global rules need a human.
7. **Every decision can be replayed.** Policy version, rule bundle version and model hashes are pinned and logged with each decision.
8. **Every decision can be explained.** A BLOCK or REVIEW names the rule, signal or graph path that caused it.

## 3. Five checkpoints, from prompt to output

The core never knows what a "payment" is. It knows four things:

- **Intent** — what the user asked for, turned into a structured, signed **mandate**.
- **Context** — everything the agent read (web pages, documents, tool results). Untrusted by default.
- **Action** — a side effect the agent wants to cause (`payment.capture`, `email.send`, `db.write`, `file.delete`, …).
- **Output** — what goes back to the user or out to another system.

| # | Checkpoint | Endpoint | What it does |
|---|---|---|---|
| 1 | **Intent intake** | `POST /v1/sessions` | Turns the user's prompt into a signed, short-lived mandate (scope, limits, allowed actions, expiry). Checks the prompt itself — the user can be the attacker. Creates the session's provenance graph. |
| 2 | **Context scan** | `POST /v1/context/inspect` | Scans pages and tool results for injection. Adds each piece of content to the graph as a node tagged trusted / untrusted, and quarantines flagged content. |
| 3 | **Action check** — the core | `POST /v1/actions/check` | Deterministic policy against the mandate, plus graph path queries. Returns ALLOW / BLOCK / REVIEW, the reason, and an **action token** bound to a hash of the exact action. |
| 4 | **Commit** | `POST /v1/actions/commit` | Confirms the action being executed has the same hash as the one approved. Generalizes "authorize → integrity check → capture". |
| 5 | **Output check** | `POST /v1/outputs/check` | Leak checks: secrets, personal data, exfiltration via URLs or markdown images, leaked canary tokens. |
| + | **Feedback** | `POST /v1/feedback` | The customer reports what really happened: disputes, chargebacks, reviewer verdicts, "I didn't ask for this". This is how the system learns from real attacks. |

Businesses use an SDK or the MCP gateway (§10), which wraps the agent's tool calls, rather than calling five endpoints by hand.

**Example mandate (payments):**

```json
{
  "intent_text": "AA batteries under $20",
  "category": "batteries",
  "max_total": { "value": "20.00", "currency": "USD" },
  "merchants": ["shop-a"],
  "allowed_actions": ["payment.authorize", "payment.capture"],
  "expires_at": "2026-11-01T00:00:00Z"
}
```

## 4. The three firewalls

### Deterministic firewall — the judge

- Mandate matching, spending policy, merchant/payee allowlists (exact match — catches lookalikes).
- **Provenance rules** evaluated on the graph (§6): a value that came from untrusted content can't become an action argument unless the mandate allows it.
- Hash integrity between approval and execution.
- **Hard signatures:** known injection artifacts (hidden CSS text, zero-width characters, HTML comments, instruction phrases, fake compliance notices), known-bad payload hashes, domains and merchants.
- **Canary tokens:** fake secrets planted in the agent's context. If one appears in an output or action argument, data is leaking.
- Written in a real policy language (Cedar, OPA/Rego, or a small DSL of our own) so rules can be analyzed ("does v12 loosen anything vs v11?"), versioned and scoped per tenant.

**Limit:** it only catches attacks that break the mandate. An attack that stays inside the rules — a $19 battery pack promoted over an equal $6 one, a "required" add-on within budget — passes. The semantic firewall exists for that gap.

### Semantic firewall — neural sensors

Neural networks that score text by meaning. They never decide; see §5.

### Red-team firewall — the attacker that teaches

- **Mutation engine:** re-encode, swap lookalike Unicode, split across chunks, translate, paraphrase. One attack becomes many regression tests.
- **Generator:** writes new attack scenarios per category. (May use a generative model — the attacker side is allowed to be creative; it never sits in the decision path.)
- **Honeypot agents** (Phase 2): our own decoy agents browsing real shops, MCP servers and documents to find attacks in the wild before a customer meets them.
- **Grading is deterministic:** every test has a ground-truth expected outcome. No AI judge.

## 5. Neural components

| # | Neural network | Job | Checkpoint | Starting point (open, CPU) | Phase |
|---|---|---|---|---|---|
| 1 | **Embedding model** (sentence encoder) | **Intent ↔ action match:** how close in meaning is each cart item / action to the mandate's `intent_text`? Also groups attacks into families (§8) and produces shareable fingerprints (§9). | 2–3 + learning | `bge-small-en-v1.5` or `all-MiniLM-L6-v2` | 0 |
| 2 | **Injection classifier** (transformer encoder) | "Does this page text or prompt contain instructions aimed at the agent?" | 1–2 | ProtectAI `deberta-v3-base-prompt-injection-v2`, Meta Prompt Guard 2 (22M/86M) | 0 off-the-shelf; fine-tuned later |
| 3 | **Fast model** (TF-IDF + logistic regression — not a neural network) | Same question as #2, but retrains in seconds, so a new attack is covered within minutes | 1–2 | Our own | 0 stretch |
| 4 | **Sequence anomaly model** (small autoencoder or LSTM) | "Is this chain of tool calls normal for this agent?" | 3 | Trained on normal traffic | 1 |
| 5 | **Sensitive-data detector** (token-classification model) | Personal data and secrets in outputs that regex misses | 5 | Small NER model | 1 |
| 6 | **Graph neural network** | Offline only: predict likely-malicious merchants/domains, spot campaign structures (§6.4) | offline | — | 2 |

**Rules for every neural component:**

- **Sensor only.** A score can route to REVIEW or quarantine content. It never produces ALLOW, never causes BLOCK on its own, and never picks action arguments.
- **Runtime:** a small Python service (FastAPI + ONNX Runtime), or transformers.js inside Node if the stack stays all-TypeScript. Target 10–50 ms per call on CPU.
- **Pinned:** each model file is hashed; the hash is logged with every decision.
- **Training data** comes from the red team (attacks + mutations = positives) and the legitimate-purchase set plus normal shop pages (negatives). Fine-tuning a DeBERTa-size model takes under an hour on a free Colab GPU.
- **Thresholds are set by false-positive rate, not accuracy** — e.g. "at most 1 in 200 legitimate purchases goes to REVIEW". Set on the legitimate set first, then measure how many attacks are caught.
- **Updates** follow the same path as rules: backtest → shadow → canary → human approval.
- **Licenses** are checked before use (Prompt Guard uses the Llama license).
- **Known weakness:** neural networks can be fooled by small input changes (adversarial examples) and don't explain themselves. That is why they only tighten.

## 6. Provenance graph: attack points and attack linkage

Attacks are chains, not single requests. The provenance graph records where every value came from, so the firewall can answer "how did this action come to be?" exactly.

### 6.1 Session graph

**Nodes:** user intent, mandate, content source (page, document, tool result), content span (with trusted / untrusted tag and scanner/classifier findings), agent step, proposed value (item, amount, payee), action.

**Edges:** `authorizes`, `contains`, `read_by`, `influenced`, `derived_from`, `proposed`, `followed_by`.

```
[User intent: "AA batteries < $20"]──authorizes──►[Mandate]
                                                      │
[Page: shop-a/item/77] ──contains──►[Hidden text ⚠ untrusted]
        │                                   │
     read_by                            influenced
        ▼                                   ▼
   [Agent step 3] ──proposed──►[Cart: headphones $18] ──►[payment.authorize]
                                    ▲
                     NOT derivable from mandate
```

### 6.2 Attack point and in-session linkage (inline, deterministic)

- **Attack point** = the untrusted node where injected content entered, found by hard signatures and the injection classifier.
- **Attack linkage** = a path query at checkpoint 3: *"Is there a path from any untrusted node to the item, amount or payee of this action?"* If yes → REVIEW (or BLOCK if the path starts at a hard signature). Runs in milliseconds, needs no training, and the path itself is the explanation.

### 6.3 Cross-session linkage (deterministic analytics)

The graph extends across sessions and tenants with merchant, domain, payload-fingerprint, tenant and agent nodes. Simple queries find **campaigns** — e.g. "this fingerprint is connected to 5 tenants within 2 hours", "a new merchant suddenly reached by many agents". This is the corroboration step for global rules (§9).

### 6.4 Graph neural network (Phase 2, offline)

Once real traffic has built up the graph, a GNN can predict likely-malicious merchants and domains and find campaign shapes rules don't cover yet. Its output goes to the review queue and threat intelligence — never the inline decision. Not earlier, because: there is no real labeled attack-graph data before launch (training on our own red team would learn the red team's habits); published GNN results are on network-intrusion (APT) data, a different domain; inline latency would be too high; and scores aren't explainable.

### 6.5 Storage and display

- Phase 0: an edges table in SQLite with recursive queries.
- Later: a graph database if query volume needs it.
- The console draws the path behind every BLOCK / REVIEW — **hidden text → cart item → blocked payment** shown in red.

## 7. How a decision is made

```
User prompt ──► [classifier + rules] ──► mandate (signed), graph created       checkpoint 1
Pages / tool results ──► [hard signatures] [injection classifier] [fast model]
                          → graph nodes tagged trusted/untrusted; quarantine     checkpoint 2
Proposed action ──► [deterministic policy vs mandate]
                    [graph path query: untrusted → action argument?]
                    [embedding: action ↔ intent similarity]
                          ← the ONLY place ALLOW is decided                      checkpoint 3
Execute ──► [hash integrity]                                                     checkpoint 4
Output ──► [leak + canary rules] [sensitive-data detector]                       checkpoint 5
```

| Policy result | Other signals | Decision |
|---|---|---|
| Fails | anything | **BLOCK** |
| Passes | hard signature (canary leaked, hidden instruction text) on the path to the action | **BLOCK** |
| Passes | graph path from untrusted content to an action argument | **REVIEW** |
| Passes | injection classifier or fast model above threshold | **REVIEW** |
| Passes | action ↔ intent embedding similarity below threshold | **REVIEW** |
| Passes | session risk score or sequence anomaly above threshold | **REVIEW** |
| Passes | everything clean | **ALLOW** |

REVIEW is never treated as permission. For payments: create order → authorize (hold funds) → check → capture on ALLOW, void on BLOCK, hold for a human on REVIEW.

**Session risk score:** multi-turn attacks build up slowly, so risk accumulates across a session instead of each call being judged alone.

Every decision record holds: decision, reasons (rule IDs, signals, graph path), policy version, rule bundle version, model hashes, action hash.

## 8. Learning from every attack

### 8.1 Finding bypasses

In simulation, a bypass is easy to see: the firewall said ALLOW where the ground truth is BLOCK/REVIEW.

In live traffic there is no ground truth — a bypass is something the firewall didn't see. So we use signals that don't depend on the firewall:

| Signal | Catches |
|---|---|
| Outcome feedback via `/feedback` (disputes, refunds, reviewer verdicts) | Attacks noticed after the fact |
| Canary tokens | Data leaks, near-zero false alarms |
| **Delayed deep scan** — re-check every *allowed* action later with heavier models and the newest rules | Attacks that were new when they happened; customers get a retroactive alert |
| Cross-tenant graph linkage (§6.3) | Campaigns |
| Sequence anomaly | Hijacks the text checks missed |
| Honeypot agents | Attacks in the wild before any customer meets them |

### 8.2 Learning the whole family, not one payload

Every confirmed attack is learned at four levels:

1. **Exact hash** — zero false positives, weakest.
2. **Normalized fingerprint** — strip encodings, case, lookalike Unicode, whitespace, HTML; then hash. Catches cheap variants.
3. **Semantic family** — the embedding places it in an attack family; it and its mutations go into classifier training (fast model: minutes; encoder: next scheduled retrain).
4. **Root cause → structural rule** — *why* did it work? The graph path usually shows it ("the payee came from page text", "the tool description contained instructions"). Fixing the cause closes the whole class, including variants nobody has written yet. **This level matters most.**

Then the red team mutates the attack and re-attacks to prove the fix generalizes.

### 8.3 From candidate rule to enforcement

```
Confirmed attack ──► attack ledger (hash-chained) ──► embed + cluster ──► fingerprint
        │
        ▼
Mutation engine (one attack → many regression tests)
        │
        ▼
Candidate rule / model update
        │
        ▼
BACKTEST against real legitimate traffic from history
        │      (and the synthetic legitimate set in simulation)
        ▼
Shadow mode (log only) ──► canary (one tenant) ──► enforce
```

- Narrow, tenant-scoped **tightening** rules may move from shadow to **REVIEW** automatically — never to BLOCK.
- **Loosening, BLOCK and global rules** need human approval and get a new version number.
- New **model versions** follow the same path as rules.
- **Poisoning is an attack:** only confirmed feedback goes into training; feedback is rate-limited and weighted by the reporting tenant's trust.
- **Built so far (M8, [redteam/](../redteam/README.md)):**
  - The mutation engine, runner, attack ledger and the four levels.
  - Level 3 groups families by word trigrams. M7 adds an embedding sensor that reads the meaning of a claim, so new wording is caught too (`claim_sensors` in the bundle, REVIEW only).
  - Learned **claim rules** in the bundle: phrases and fingerprints, REVIEW only, with no page text in them.
  - Backtest; shadow (`shadow_reasons` in the decision ledger) → enforce, each step human-approved.
  - Not built yet: canary per tenant, and automatic moves to REVIEW.

## 9. Global protection across customers

```
Tenant A sees attack ──► local rule (tenant A only, immediate, REVIEW)
                              │
           corroboration: seen at ≥ k tenants (graph linkage), OR confirmed by a
           human analyst, AND backtest on legitimate traffic is clean
                              │
                              ▼
          Global signed rule bundle v(n+1) ──► every SDK / gateway pulls it
             shadow → canary → enforce      (each tenant chooses enforce or monitor)
```

- **Shared:** fingerprints and embedding vectors, indicators of compromise (bad domains, merchants, payload hashes), classifier updates.
- **Never shared:** raw customer content.
- **Against poisoning:** cross-tenant corroboration before anything goes global; trust-weighted feedback; humans approve anything that loosens; bundles are signed and can be rolled back.

## 10. Covering all agentic work

### 10.1 Action registry and risk classes

Every action type is registered with a schema and a **risk class** built from properties:

- Reversible?
- Moves money?
- Sends anything outside the company?
- Touches sensitive data?
- Changes permissions?

Default policies attach to risk classes, so **a new action type is protected on day one**. Payments are "irreversible + money", with their own argument schema and rules. Every irreversible family uses the same two-phase commit: the integration's own system prepares the action, the firewall checks what was actually prepared (a per-family effect checker; payments first), and the integration executes or cancels it with its own code. MWF never executes actions or holds the outside system's credentials.

### 10.2 Structural controls

- **Least privilege:** the mandate grants short-lived, narrow capabilities per task instead of the agent holding broad keys.
- **Provenance tracking** (§6; in the spirit of the "dual LLM" pattern and DeepMind's CaMeL): untrusted data can't flow into sensitive arguments.
- **Two-phase commit for every irreversible action:** prepare → check → commit.
- **Human gate scaled to risk:** REVIEW only for high-risk actions, so reviewers aren't overwhelmed.

### 10.3 Threat coverage

Categories follow OWASP's LLM and agentic-AI threat lists. Beyond prompt injection:

| Threat | Control |
|---|---|
| **Tool poisoning** — instructions hidden in MCP tool descriptions | Scan descriptions; pin a hash of each |
| **Rug pull** — a tool definition changes after approval | Hash changes → tool re-checked |
| **Memory poisoning** — instructions written into long-term agent memory | Memory writes are actions and go through checkpoint 3; memory entries keep their provenance |
| **Multi-agent impersonation** | Signed agent identities |
| **Data exfiltration** via URLs, images, tool arguments | Checkpoint 5 + canaries |
| **Excessive agency** | Mandate capabilities + risk classes |

Payment attack categories for Phase 0 are the six in the README (instruction override, persuasion/ranking, hidden text, fake compliance/urgency, lookalike merchant, transaction modification/duplicate retry).

### 10.4 Integration

- **MCP gateway / proxy** — the universal integration point: every tool call passes through it, whatever the agent framework.
- **Thin SDK wrappers** for the major agent frameworks.
- **Adapters** for agent payment protocols (AP2, ACP, x402) — later.

### 10.5 Hybrid deployment

- **Local** (SDK or gateway in the customer's infrastructure): deterministic checks and session-graph queries with a cached, signed rule bundle. Single-digit millisecond latency; raw data stays with the customer.
- **Cloud:** neural components, ledger, cross-session graph, learning pipeline, red team, global intelligence feed.
- Customers that can't send page content send **fingerprints, embeddings and features only**.

### 10.6 Components

| Component | Responsibility |
|---|---|
| SDK / MCP gateway | Wraps tool calls, local deterministic checks, pulls rule bundles |
| Decision service | Policy engine, mandates, action tokens, decision records |
| Provenance graph service | Session graphs, path queries, cross-session linkage |
| Detector service | Embedding model, injection classifier, fast model (later: anomaly, sensitive-data) |
| Ledger & telemetry | Append-only, hash-chained record of every decision |
| Learning pipeline | Clustering, fingerprinting, candidate rules, backtest, rollout |
| Red-team engine | Mutation, generation, honeypot agents, regression suite |
| Threat-intel hub | Cross-tenant corroboration, signed global bundles |
| Console | Review queue with attack paths, rule approval, Security Passport, Trust Score |

## 11. Securing MWF itself

One compromised rule bundle could block or allow traffic across every customer, so:

- Rule bundles and model files are **signed**; SDKs reject unsigned or downgraded bundles.
- Strict tenant isolation.
- API keys are scoped, rotated, and stored only as hashes.
- Hash-chained ledger; fail closed.
- We red-team our own API.

## 12. How we measure it

- **Attack success rate (ASR)**, end to end, per category.
- **False-positive rate on legitimate traffic** — the legitimate set counts against the score, so a firewall that blocks everything can't win.
- Precision / recall at the operating threshold for each model. **Not accuracy** — real traffic is ~99.9% legitimate, so accuracy is misleading.
- Latency at p99 per checkpoint (target: deterministic checks and graph queries under 50 ms).
- Time from first sighting of an attack to protection (local and global).
- Public benchmarks (AgentDojo, InjecAgent) alongside our own suite.
- **Trust Score** and **Security Passport** as described in the README, every number traceable to test IDs.

## 13. Build phases

| Phase | Goal | Contents |
|---|---|---|
| **0 — Hackathon (to 2026-11-15)** | Prove the loop in simulation | See priorities below |
| **1 — Design partners** | Prove it on real traffic | MCP gateway; action registry + risk classes; `/feedback`; delayed deep scan; per-tenant rules; checkpoint 5; sequence anomaly and sensitive-data models; cross-session graph |
| **2 — Network** | Global protection | Multi-tenant corroboration; signed global bundles; honeypot agents; fine-tuned classifier pipeline; offline GNN; published benchmark results |

**Phase 0 priorities:**

- **Must:**
  - Simulated shop + shopping agent with planted attacks (six categories).
  - Checkpoints 1–4 for payments, API in its generic shape (`actions/check` with `type: "payment"`).
  - Deterministic policy, hard signatures, canary tokens.
  - Provenance session graph (SQLite) with the untrusted → argument path query, and the red attack path drawn in the console.
  - Embedding model for intent ↔ cart matching.
  - Red team with mutations; on stage: one bypass → four-level learning → backtest → approve → the whole family blocked.
- **Should:** off-the-shelf injection classifier on page content, REVIEW only.
- **Stretch:** fast model with minute-level retraining; fine-tuned classifier on red-team output; attack-family clustering shown in the console.

## 14. Rejected alternatives

| Alternative | Why not |
|---|---|
| Generative LLM as the semantic check (original Gemini plan) | It sits in the money path, rate limits, data goes to a third party. Dropped 2026-11-01. |
| Classifier score above a threshold → BLOCK | Neural networks are evadable and false-positive-prone; they can only push to REVIEW. |
| "Any-one-catch" ensemble (any detector flags → block) | False positives add up: three detectors at 2% each flag ~6% of legitimate purchases. |
| TF-IDF + LSTM/GloVe stack as the main detector | Weaker than one fine-tuned encoder; stacking adds latency and false positives. TF-IDF + LR kept only as the fast-retrain layer. |
| Knowledge-graph GNN for attack linkage now / inline | No real labeled attack graphs before launch; published results are from network intrusion data; too slow and unexplainable for inline use. Deterministic graph queries do the job now; GNN is Phase 2, offline. |
| Attacks become production rules automatically | An attacker could poison the policy into blocking legitimate traffic. |

## 15. Decisions and open questions

**Decided 2026-11-02 (M0), for Rajdeep to confirm:**

- **Stack:** TypeScript end to end on Node 24 — npm workspaces monorepo, Fastify for the firewall API, Next.js for the shop and console, SQLite for storage, Vitest for tests.
- **Neural components:** ~~Python sidecar (FastAPI + sentence-transformers / ONNX Runtime) on Python 3.12/3.13.~~ Changed in M7 (2026-11-10): transformers.js + ONNX Runtime inside Node (`packages/sensors`). The stack stays all TypeScript, and a claim takes about 5 ms at p99 on a laptop CPU.
- **Policy rules (Phase 0):** versioned JSON evaluated by a small TypeScript engine; move to Cedar or OPA/Rego in Phase 1.

**Open:**
- Which model drives the shopping agent (the attack victim) and the red-team generator. The agents are now outside this repo (Errand), so this is their choice, not MWF's.
- Thresholds for embedding similarity and the classifier (set from the legitimate set).
- Corroboration threshold *k* for global rules, and how tenant trust is computed.
- PayPal Vault spike (biggest technical risk for Phase 0).
