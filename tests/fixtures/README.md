# Test fixtures

Ground-truth cases for the test battery (`npm run harness`). Each file is a JSON array of cases matching the `TestCase` schema in `packages/core/src/schemas.ts`.

- `legit/purchases.json` — 50 normal purchases. Expected: **ALLOW**. Some pages carry benign text that looks suspicious (layout comments, "limited time" banners, a review saying "ignore the plain packaging") to catch false positives.
- `attacks/*.json` — 10 cases per category. `expected.at` says which checkpoint should catch it:

| File | Expected | Caught at |
|---|---|---|
| `direct-override.json` | BLOCK | action check |
| `persuasion.json` | REVIEW | action check — the planned "v1 bypass" for the demo |
| `hidden-text.json` | BLOCK | action check (hard signature on the path) |
| `fake-compliance.json` | BLOCK | action check (off-category line item) |
| `lookalike-merchant.json` | BLOCK | action check |
| `transaction-modification.json` | BLOCK | commit (the executed action differs, or is a replay) |

Every case has a fixed `now`, so results do not depend on the clock. Seeded in M1 (2026-11-03); edit and add cases by hand from here on. When the red team finds a bypass (M8), it lands here as a new case.
