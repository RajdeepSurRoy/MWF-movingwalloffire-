# Red team and learning loop (M8)

Finds attacks that get past the firewall, learns a rule from them, and rolls the rule out only after a backtest and a person's approval. Nothing here changes a decision by itself.

```bash
npm run redteam -- demo                              # the whole loop in memory; writes nothing
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
   3. **family:** a near copy of a known claim. This uses word-trigram similarity; M7's embeddings replace it.
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
  - It is **not approved yet**: approval is a person's decision.
- `demo` trains on 5 persuasion seeds and tests on the other 5:
  - On the training seeds and their 135 variants, v1 lets 119 through; after enforcement, 0 get through.
  - On the 5 unseen seeds and their variants (including the held-out wording), 101 of 140 get through, before and after.
- **Limit:** a phrase rule covers the attack families it has seen, re-encoded or restructured. It does not cover new wording. That is level 3's job with real embeddings (M7).

## Known limits

- Only one root-cause template exists. Bypasses it cannot explain are recorded as `unexplained` for a person to look at.
- **Poisoning:** an attacker could plant ordinary phrases in attacks to get a rule that holds competitors' normal purchases. Current guards:
  - the benign contrast
  - the backtest
  - human approval
  - REVIEW-only rules

  Sharing rules across tenants still needs corroboration from several tenants before a rule spreads; that part is not built.
- `data/benign.txt` is hand-written. Text from real integrations' pages (no customer data) makes the contrast stronger.
