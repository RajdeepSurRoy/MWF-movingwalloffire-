# MWF Security Architecture

> Status: **design.** Nothing here is implemented yet. Agreed on 2026-11-01. Where this document and the README disagree, this document wins (in particular: the firewall uses no generative LLM — see [§4](#4-the-three-firewalls)).

## Contents

1. [What we are building](#1-what-we-are-building)
2. [Principles](#2-principles)
3. [Five checkpoints, from prompt to output](#3-five-checkpoints-from-prompt-to-output)
4. [The three firewalls](#4-the-three-firewalls)
5. [How a decision is made](#5-how-a-decision-is-made)
6. [Learning from every attack](#6-learning-from-every-attack)
7. [Global protection across customers](#7-global-protection-across-customers)
8. [Covering all agentic work](#8-covering-all-agentic-work)
9. [Securing MWF itself](#9-securing-mwf-itself)
10. [How we measure it](#10-how-we-measure-it)
11. [Build phases](#11-build-phases)
12. [Rejected alternatives](#12-rejected-alternatives)
13. [Open questions](#13-open-questions)

---

## 1. What we are building

A security layer that businesses get through an **API key** to protect their AI agents — from the moment a user gives a prompt to the final output. Payments (PayPal) are the first thing it protects; the design is general so every agentic workflow can follow.

The plan has three stages:

1. **Stress test in simulation.** A simulated third-party e-commerce site and a shopping agent. We plant attacks; the security layer sees them.
2. **Block and learn.** The firewall blocks known attack patterns. When an attack gets through, the red team identifies it, the firewall learns it, and similar future attacks are blocked.
3. **Learn live, protect globally.** The same loop runs on real customer traffic. An attack one business meets is learned and protects every other business.

## 2. Principles

1. **Cryptography proves an action was executed correctly; it can't prove the decision was right.** So every action is checked against what the user actually asked for.
2. **Only deterministic code can say ALLOW.** Models are sensors: they can make a decision stricter, never looser.
3. **No generative LLM in the firewall.** No model writes text or decides. Nothing is sent to a third-party AI provider.
4. **Structure beats detection.** Least privilege, provenance tracking and two-phase commit close whole classes of attack. Detection is an arms race; we use it as a second line.
5. **Fail closed.** If the firewall can't decide in time, the action doesn't happen.
6. **Nothing loosens automatically.** Tightening can be automated within limits; loosening, BLOCK rules and global rules need a human.
7. **Every decision can be replayed.** Policy version, rule bundle version and model version are pinned and logged.

## 3. Five checkpoints, from prompt to output

The core never knows what a "payment" is. It knows four things:

- **Intent** — what the user asked for, turned into a structured, signed **mandate**.
- **Context** — everything the agent read (web pages, documents, tool results). Untrusted by default.
- **Action** — a side effect the agent wants to cause (`payment.capture`, `email.send`, `db.write`, `file.delete`, …).
- **Output** — what goes back to the user or out to another system.

| # | Checkpoint | Endpoint | What it does |
|---|---|---|---|
| 1 | **Intent intake** | `POST /v1/sessions` | Turns the user's prompt into a signed, short-lived mandate (scope, limits, allowed actions, expiry). Checks the prompt itself — the user can be the attacker. |
| 2 | **Context scan** | `POST /v1/context/inspect` | Scans pages and tool results for injection (hidden text, zero-width characters, instruction-like phrases, fake notices). Tags every piece of content with **provenance** (trusted / untrusted) and quarantines flagged content. |
| 3 | **Action check** — the core | `POST /v1/actions/check` | Deterministic policy against the mandate and provenance rules. Returns ALLOW / BLOCK / REVIEW and an **action token** bound to a hash of the exact action. |
| 4 | **Commit** | `POST /v1/actions/commit` | Confirms the action being executed has the same hash as the one approved. Generalizes "authorize → integrity check → capture". |
| 5 | **Output check** | `POST /v1/outputs/check` | Leak checks: secrets, personal data, exfiltration via URLs or markdown images, leaked canary tokens. |
| + | **Feedback** | `POST /v1/feedback` | The customer reports what really happened: disputes, chargebacks, reviewer verdicts, "I didn't ask for this". This is how the system learns from real attacks. |

Businesses use an SDK or the MCP gateway (§8), which wraps the agent's tool calls, rather than calling five endpoints by hand.

**Example mandate (payments):**

```json
{
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
- **Provenance rules:** a value that came from untrusted content (a price on a page, a payee name) can't become an action argument unless the mandate allows it.
- Hash integrity between approval and execution.
- **Hard signatures:** known injection artifacts (hidden CSS text, zero-width characters, HTML comments, instruction phrases, fake compliance notices), known-bad payload hashes, domains and merchants.
- **Canary tokens:** fake secrets planted in the agent's context. If one appears in an output or action argument, data is leaking.
- Written in a real policy language (Cedar, OPA/Rego, or a small DSL of our own) so rules can be analyzed ("does v12 loosen anything vs v11?"), versioned and scoped per tenant.

**Limit:** it only catches attacks that break the mandate. An attack that stays inside the rules — a $19 battery pack promoted over an equal $6 one, a "required" add-on within budget — passes. That gap is why the semantic layer exists.

### Semantic firewall — sensors, not judges

Decided 2026-11-01: **classifier as sensor, policy as judge.**

- **Encoder classifier** (DeBERTa / Prompt Guard class). Non-generative, runs on our servers, version-pinned so the same input always gets the same score. Start from an existing open injection classifier, then fine-tune on our red team's output.
- **Fast model** (TF-IDF + logistic regression). Weaker, but retrains in seconds — a newly confirmed attack is in it within minutes, while the encoder retrains on a schedule.
- They score **untrusted content and the user's prompt** (checkpoints 1–2): "does this text contain instructions aimed at the agent?" They don't decide whether an action happens.
- A high score means **REVIEW or quarantine**, never ALLOW, and not BLOCK on its own. Text classifiers are evadable and misfire on harmless instruction-like text ("please add to cart").

### Red-team firewall — the attacker that teaches

- **Mutation engine:** re-encode, swap lookalike Unicode, split across chunks, translate, paraphrase. One attack becomes many regression tests.
- **Generator:** writes new attack scenarios per category. (May use a generative model — the attacker side is allowed to be creative; it never sits in the decision path.)
- **Honeypot agents** (Phase 2): our own decoy agents browsing real shops, MCP servers and documents to find attacks in the wild before a customer meets them.
- **Grading is deterministic:** every test has a ground-truth expected outcome. No AI judge.

## 5. How a decision is made

```
User prompt ──► [classifier + rules] ──► mandate (signed)                 checkpoint 1
Pages / tool results ──► [hard signatures] [fast model] [encoder classifier]
                          → provenance tags; quarantine if flagged         checkpoint 2
Proposed action ──► [deterministic policy vs mandate + provenance rules]   checkpoint 3
                          ← the ONLY place ALLOW is decided
Execute ──► [hash integrity]                                               checkpoint 4
Output ──► [leak + canary rules]                                           checkpoint 5
```

| Policy result | Other signals | Decision |
|---|---|---|
| Fails | anything | **BLOCK** |
| Passes | hard signature (canary leaked, hidden instruction text) | **BLOCK** |
| Passes | classifier or fast model above threshold | **REVIEW** |
| Passes | action argument came from untrusted content | **REVIEW** |
| Passes | session risk score above threshold | **REVIEW** |
| Passes | everything clean | **ALLOW** |

REVIEW is never treated as permission. For payments: create order → authorize (hold funds) → check → capture on ALLOW, void on BLOCK, hold for a human on REVIEW.

**Session risk score:** multi-turn attacks build up slowly, so risk accumulates across a session instead of each call being judged alone.

## 6. Learning from every attack

### 6.1 Finding bypasses

In simulation, a bypass is easy to see: the firewall said ALLOW where the ground truth is BLOCK/REVIEW.

In live traffic there is no ground truth — a bypass is something the firewall didn't see. So we need signals that don't depend on the firewall:

| Signal | Catches |
|---|---|
| Outcome feedback via `/feedback` (disputes, refunds, reviewer verdicts) | Attacks noticed after the fact |
| Canary tokens | Data leaks, near-zero false alarms |
| **Delayed deep scan** — re-check every *allowed* action later with heavier models and the newest rules | Attacks that were new when they happened; customers get a retroactive alert |
| Cross-tenant correlation — same payload, new merchant or domain appearing at many tenants | Campaigns |
| Behavior anomaly — tool-call sequences unusual for that agent | Hijacks the text checks missed |
| Honeypot agents | Attacks in the wild before any customer meets them |

### 6.2 Learning the whole family, not one payload

Every confirmed attack is learned at four levels:

1. **Exact hash** — zero false positives, weakest.
2. **Normalized fingerprint** — strip encodings, case, lookalike Unicode, whitespace, HTML; then hash. Catches cheap variants.
3. **Semantic family** — the attack and its mutations go into classifier training (fast model: minutes; encoder: next scheduled retrain).
4. **Root cause → structural rule** — *why* did it work? ("the payee came from page text", "the tool description contained instructions"). Fixing the cause closes the whole class, including variants nobody has written yet. **This level matters most.**

Then the red team mutates the attack and re-attacks to prove the fix generalizes.

### 6.3 From candidate rule to enforcement

```
Confirmed attack ──► attack ledger (hash-chained) ──► cluster ──► fingerprint
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
- New **model versions** go through the same path as rules.
- **Poisoning is an attack:** only confirmed feedback goes into training; feedback is rate-limited and weighted by the reporting tenant's trust.

## 7. Global protection across customers

```
Tenant A sees attack ──► local rule (tenant A only, immediate, REVIEW)
                              │
           corroboration: seen at ≥ k tenants, OR confirmed by a human analyst,
           AND backtest on legitimate traffic is clean
                              │
                              ▼
          Global signed rule bundle v(n+1) ──► every SDK / gateway pulls it
             shadow → canary → enforce      (each tenant chooses enforce or monitor)
```

- **Shared:** fingerprints, indicators of compromise (bad domains, merchants, payload hashes), classifier updates.
- **Never shared:** raw customer content.
- **Against poisoning:** cross-tenant corroboration before anything goes global; trust-weighted feedback; humans approve anything that loosens; bundles are signed and can be rolled back.

## 8. Covering all agentic work

### 8.1 Action registry and risk classes

Every action type is registered with a schema and a **risk class** built from properties:

- Reversible?
- Moves money?
- Sends anything outside the company?
- Touches sensitive data?
- Changes permissions?

Default policies attach to risk classes, so **a new action type is protected on day one**. Payments are "irreversible + money", plus a payments plugin with its own schema, rules and two-phase commit.

### 8.2 Structural controls

- **Least privilege:** the mandate grants short-lived, narrow capabilities per task instead of the agent holding broad keys.
- **Provenance tracking** (in the spirit of the "dual LLM" pattern and DeepMind's CaMeL): untrusted data can't flow into sensitive arguments.
- **Two-phase commit for every irreversible action:** prepare → check → commit.
- **Human gate scaled to risk:** REVIEW only for high-risk actions, so reviewers aren't overwhelmed.

### 8.3 Threat coverage

Categories follow OWASP's LLM and agentic-AI threat lists. Beyond prompt injection:

| Threat | Control |
|---|---|
| **Tool poisoning** — instructions hidden in MCP tool descriptions | Scan descriptions; pin a hash of each |
| **Rug pull** — a tool definition changes after approval | Hash changes → tool re-checked |
| **Memory poisoning** — instructions written into long-term agent memory | Memory writes are actions and go through checkpoint 3 |
| **Multi-agent impersonation** | Signed agent identities |
| **Data exfiltration** via URLs, images, tool arguments | Checkpoint 5 + canaries |
| **Excessive agency** | Mandate capabilities + risk classes |

Payment attack categories for Phase 0 are the six in the README (instruction override, persuasion/ranking, hidden text, fake compliance/urgency, lookalike merchant, transaction modification/duplicate retry).

### 8.4 Integration

- **MCP gateway / proxy** — the universal integration point: every tool call passes through it, whatever the agent framework.
- **Thin SDK wrappers** for the major agent frameworks.
- **Adapters** for agent payment protocols (AP2, ACP, x402) — later.

### 8.5 Hybrid deployment

- **Local** (SDK or gateway in the customer's infrastructure): deterministic checks with a cached, signed rule bundle. Single-digit millisecond latency; raw data stays with the customer.
- **Cloud:** classifiers, ledger, learning pipeline, red team, global intelligence feed.
- Customers that can't send page content send **fingerprints and features only**.

### 8.6 Components

| Component | Responsibility |
|---|---|
| SDK / MCP gateway | Wraps tool calls, local deterministic checks, pulls rule bundles |
| Decision service | Policy engine, mandates, action tokens |
| Detector service | Fast model + encoder classifier |
| Ledger & telemetry | Append-only, hash-chained record of every decision |
| Learning pipeline | Clustering, fingerprinting, candidate rules, backtest, rollout |
| Red-team engine | Mutation, generation, honeypot agents, regression suite |
| Threat-intel hub | Cross-tenant corroboration, signed global bundles |
| Console | Review queue, rule approval, Security Passport, Trust Score |

## 9. Securing MWF itself

One compromised rule bundle could block or allow traffic across every customer, so:

- Rule bundles are **signed**; SDKs reject unsigned or downgraded bundles.
- Strict tenant isolation.
- API keys are scoped, rotated, and stored only as hashes.
- Hash-chained ledger; fail closed.
- We red-team our own API.

## 10. How we measure it

- **Attack success rate (ASR)**, end to end, per category.
- **False-positive rate on legitimate traffic** — the legitimate set counts against the score, so a firewall that blocks everything can't win.
- Precision / recall at the operating threshold for each model. **Not accuracy** — real traffic is ~99.9% legitimate, so accuracy is misleading.
- Latency at p99 per checkpoint (target: deterministic checks under 50 ms).
- Time from first sighting of an attack to protection (local and global).
- Public benchmarks (AgentDojo, InjecAgent) alongside our own suite.
- **Trust Score** and **Security Passport** as described in the README, every number traceable to test IDs.

## 11. Build phases

| Phase | Goal | Contents |
|---|---|---|
| **0 — Hackathon (to 2026-11-15)** | Prove the loop in simulation | Simulated shop + agent; checkpoints 1–4 for payments, API in its generic shape (`actions/check` with `type: "payment"`); deterministic policy; hard signatures; provenance on price and payee; canaries; off-the-shelf classifier routed to REVIEW; mutating red team; on stage: one bypass → four-level learning → backtest → approve → the whole family blocked |
| **1 — Design partners** | Prove it on real traffic | MCP gateway; action registry + risk classes; `/feedback`; delayed deep scan; per-tenant rules; checkpoint 5 |
| **2 — Network** | Global protection | Multi-tenant corroboration; signed global bundles; honeypot agents; fine-tuned classifier pipeline; published benchmark results |

**Phase 0 priority:**

- *Must:* policy gate, hard signatures, provenance on price/payee, canary tokens, red team with mutations, the learning loop shown on stage.
- *Should:* off-the-shelf encoder classifier (Python sidecar, or transformers.js if the stack stays all-TypeScript), REVIEW only.
- *Stretch:* fine-tune on red-team output; show a new attack in the fast model within minutes.

## 12. Rejected alternatives

| Alternative | Why not |
|---|---|
| Generative LLM as the semantic check (original Gemini plan) | It sits in the money path, rate limits, data goes to a third party. Dropped 2026-11-01. |
| Classifier score above a threshold → BLOCK | Classifiers are evadable and false-positive-prone; they can only push to REVIEW. |
| "Any-one-catch" ensemble (any detector flags → block) | False positives add up: three detectors at 2% each flag ~6% of legitimate purchases. |
| TF-IDF + LSTM/GloVe stack as the main detector | Weaker than one fine-tuned encoder; stacking adds latency and false positives. TF-IDF + LR kept only as the fast-retrain layer. |
| Attacks become production rules automatically | An attacker could poison the policy into blocking legitimate traffic. |

## 13. Open questions

- Stack (working suggestion: TypeScript end to end, Node backend, SQLite) and where the classifier runs.
- Policy language: Cedar vs OPA/Rego vs our own DSL.
- Whether the shopping agent (the attack victim) uses an LLM, and which.
- Corroboration threshold *k* for global rules, and how tenant trust is computed.
- PayPal Vault spike (biggest technical risk for Phase 0).
