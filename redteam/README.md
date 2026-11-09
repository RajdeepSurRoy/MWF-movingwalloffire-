# Red team and learning loop (M8)

Finds attacks that get past the firewall, learns a rule from them, and rolls the rule out only after a backtest and a person's approval. Nothing here changes a decision by itself.

```bash
npm run redteam -- demo                              # the whole loop in memory, from the bundle minus its learned rules; writes nothing
npm run redteam -- run [--category persuasion]       # mutate the attack fixtures, record bypasses
npm run redteam -- learn                             # propose a rule from the ledger, backtest it
npm run redteam -- approve <rule-id> --by <name>     # candidate → shadow (bundle version +1)
npm run redteam -- enforce <rule-id> --by <name>     # shadow → enforced (bundle version +1)
```

## The loop

1. **Mutate** (`src/mutate.ts`). Each attack fixture is a seed, and each seed gets 20+ deterministic variants, all with the seed's ground truth:
   - *encoding:* lookalike letters, zero-width characters, HTML entities, case, spacing
   - *structure:* split across elements, moved into a comment, meta tag or hidden element, name first
   - *amount:* the promoted item's price moved, staying within budget
   - *recombine:* another seed's claim, written about this seed's item
   - *paraphrase:* new wording. There are two separate sets; the held-out set is only used to test.
2. **Run** (`src/runner.ts`). Every seed and variant goes through the same decision logic as the API. A **bypass** is an ALLOW where the ground truth says REVIEW or BLOCK. Each bypass gets a root cause from a template; today the only template is *item_in_claim*: the bought item is named inside a claim on an untrusted page.
3. **Ledger** (`data/ledger.json`, `src/learn.ts`). Each bypass is recorded with its root cause and three levels of identity:
   1. **exact hash:** the same attack twice is recorded once
   2. **claim fingerprint:** the same claim re-encoded, or about another product
   3. **family:** a near copy of a known claim, by word-trigram similarity. New wording is the embedding sensor's job (below).
4. **Learn** (level 4). Per family, the learner picks the few word pairs and triples its claims share that no ordinary page uses. "Ordinary" means the legitimate fixtures plus `data/benign.txt`. The result is a candidate **claim rule** (phrases plus fingerprints).
5. **Backtest** (`src/rollout.ts`). Every legitimate purchase, every attack fixture and every variant is run with the current bundle and with the candidate. A candidate that holds any legitimate purchase, or softens any decision, cannot be approved.
6. **Roll out:**
   - `approve` adds the rule in **shadow**: it runs and is recorded (`shadow_reasons` in the decision ledger), but does not decide.
   - `enforce` makes it decide.
   - Both steps bump the bundle version, so every decision names the rules it was made with.

## What a learned rule can do

- **REVIEW only.** The bundle schema has no decision field for claim rules, so a learned rule cannot BLOCK.
- **Plain word sequences, never regexes.** Learned content can't become a slow pattern (no ReDoS).
- **No page text or item names.** A rule holds phrases and fingerprints only, so it can be shared between tenants without sharing their data.

## Results (2026-11-09, bundle 1.5.0)

- `run` over all 66 attack fixtures:
  - 898 seeds and variants; 265 get through (30%).
  - Every bypass is persuasion. The variants of the other attack types are all held.
- `learn` proposes `LRN.CLAIM.CCB11DF2`:
  - It catches 265 of 265.
  - It holds 0 of 52 legitimate purchases and softens no decision.
  - Approved by Jagrit (bundle 1.6.0, shadow) and enforced (bundle 1.7.0). The battery is now at 0% attack success and 0% false positives.
- `demo` trains on 5 persuasion seeds and tests on the other 5:
  - On the training seeds and their 135 variants, v1 lets 119 through; after enforcement, 0 get through.
  - On the 5 unseen seeds and their variants (including the held-out wording), 101 of 140 get through, before and after.
- **Limit:** a phrase rule covers the attack families it has seen, re-encoded or restructured. It does not cover new wording; the [embedding sensor](#embedding-sensor-m7) does, in part.

## Embedding sensor (M7)

```bash
npm run redteam -- sensor                            # train the persuasion sensor, backtest it
npm run redteam -- approve <SEN.id> --by <name>      # candidate → shadow, as for a rule
npm run redteam -- enforce <SEN.id> --by <name>
```

A learned phrase covers the wording it came from. The sensor reads a claim's meaning instead:

- **Model:** `all-MiniLM-L6-v2` turns the claim (the item's name replaced by "this product") into a vector. The model is pinned by revision and ONNX file hash and runs in-process ([packages/sensors](../packages/sensors)). It downloads once (23 MB) into `.cache/models`.
- **Classifier:** a logistic regression (`src/sensor.ts`) scores the vector.
  - **Positives:** the attack claims in the ledger.
  - **Negatives:** half of [data/product-copy.txt](data/product-copy.txt) (ordinary product copy that names a product) and of `data/benign.txt`.
- **Threshold:** above every one of the other halves' texts, and never below 0.5.
- **Bundle:** it goes into `claim_sensors` with its weights and model hash. No page text is stored.
- **What it can decide:**
  - It can hold for REVIEW, never BLOCK.
  - If an enforced sensor cannot score a claim (model down, timeout, other model), the claim is held (`SEN.UNAVAILABLE`).
  - Every decision records the scores and model hash.
- **Speed:** p99 is 4.7 ms per claim on a laptop CPU.

**Results (2026-11-10):**

- **`demo`, steps 9–11:**
  - Trained on the 5 training seeds' bypasses: threshold 0.55.
  - On the 5 never-seen seeds and their 135 mutations, 101 get through with the learned phrases only. With the sensor too, 27 get through.
  - 0 of 52 legitimate purchases are held.
- **`sensor`, on the whole ledger** (`SEN.PERSUASION.F0B2BBF9`, threshold 0.6):
  - Against bundle 1.7.0, the ledger's attacks and held-out wording are all caught already, by the enforced rule.
  - The test that counts is the **fresh attacks** (`tests/fixtures/fresh`): 10 persuasion seeds in wording nothing learned from, kept out of the battery. The rule lets all 300 of their variants through; the sensor catches 93 (seeds: 2 of 10).
  - It holds 0 of 52 legitimate purchases.
  - Not approved yet.
- **Limits:**
  - Ordinary shop marketing scores near real persuasion: "one of our most popular products this season" scores 0.65. Raising recall means more training data, not a lower threshold.
  - A hand-written tactics corpus as extra positives made the fresh result worse (83 vs 93 of 300) and was dropped. This was judged on the fresh set, so that set is no longer fully blind.
  - The same person wrote the fresh attacks and the negative corpus. Text from real integrations' pages is the next step.

## Known limits

- Only one root-cause template exists. Bypasses it cannot explain are recorded as `unexplained` for a person to look at.
- **Poisoning:** an attacker could plant ordinary phrases in attacks to get a rule that holds competitors' normal purchases. Current guards:
  - the benign contrast
  - the backtest
  - human approval
  - REVIEW-only rules

  Sharing rules across tenants still needs corroboration from several tenants before a rule spreads; that part is not built.
- `data/benign.txt` is hand-written. Text from real integrations' pages (no customer data) makes the contrast stronger.
