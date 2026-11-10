# PayPal sandbox run (2026-11-11)

The [attack lab](../../examples) with **PayPal** as the payment method:
```bash
LAB_PAY=paypal node examples/errand/scripts/attack-lab.mjs legit price-change
```

**Setup:**
- **Errand**, the shopping agent, logs in to PayPal's sandbox checkout with its own sandbox *buyer* account and approves the payment.
- **FreshCart**, the shop, created the PayPal order (Orders v2) with its sandbox app keys. When PayPal sends the buyer back, it captures the money.
- Sandbox only, no real money.
- The model is the offline `naive` stand-in.

**Who checks what:**

| Side | MWF tenant | What MWF checks |
|---|---|---|
| **Errand**, the buyer's agent | `errand` | The pages it reads; the purchase it wants (mandate, merchant, checkout address); and, right before *Place order*, that the checkout is still exactly what the user approved |
| **FreshCart**, the merchant | `freshcart` | Right before **capture**, what **PayPal's API** says the order holds (status, amount, **payee**), compared with the order as the shop prices it and with the PayPal account registered for FreshCart (`MWF_PAYPAL_PAYEE`). FreshCart captures only on ALLOW, then records PayPal's capture id |

The payee check runs on the merchant's side because only the merchant can see who PayPal will pay. PayPal's buyer page doesn't show it.

## Results

In PayPal mode, FreshCart's check runs in every run; "firewall off/on" in the tables is Errand's side.

| Case | Errand's firewall off | Errand's firewall on |
|---|---|---|
| Legitimate purchase ($14.98) | ✅ Paid. PayPal `4UP68642BS0657000`, capture `0M815239NY071932T`, order FC-VQ35CB | ✅ **Paid.** PayPal `28B22572T3166930J`, capture `7D823388UT216371S`, order FC-473YEH |
| Price raised after the user approved | Stopped by Errand's own total check | 🛡️ **Blocked** by MWF before *Place order* (`COMMIT.HASH_MISMATCH`); nothing paid |

**MWF's ledger for a legitimate payment.** The hash chain verifies (78 entries).

```
action  ALLOW  ALLOW.ALL_CHECKS_PASSED
commit  ALLOW  COMMIT.HASH_MATCH, COMMIT.EFFECT_MATCH      ← PayPal holds $14.98 for FreshCart's registered account
effect  prepared  paypal 28B22572T3166930J  14.98 USD  → ALLOW
effect  executed  paypal 28B22572T3166930J  capture_id 7D823388UT216371S
```

### Attack: PayPal pays someone else

The lab registers a different account as FreshCart's payee (`LAB_PAYPAL_PAYEE=payments@not-freshcart.example`). From MWF's side, this is exactly what a shop whose PayPal app keys were swapped for an attacker's would look like: the PayPal orders pay an account the store never registered.

```bash
LAB_PAY=paypal LAB_PAYPAL_PAYEE=payments@not-freshcart.example node examples/errand/scripts/attack-lab.mjs legit
```

| Run | Result |
|---|---|
| Both runs | 🛡️ **Not captured.** MWF blocked at FreshCart's commit (`COMMIT.EFFECT_PAYEE_MISMATCH`). The buyer had approved on PayPal (`6KJ21223DP263671X`, `3X427528N03430548`), but no money was taken and no order was placed. The ledger records PayPal's order id with the BLOCK (hash chain verifies, 42 entries) |

## Before the merchant-side check

Earlier the same day, Errand sent MWF the payment as seen on PayPal's buyer page, which has no payee. MWF could confirm the amount but not who would be paid, so it **held** the legitimate purchase (`COMMIT.EFFECT_PAYEE_UNVERIFIED`; PayPal `5T317263X3213344L`, never completed). That run is kept as `before-merchant-check-*.json`.

The fix moved the payee check to where the payee is visible, the merchant's capture, and Errand stopped sending a payee it can't see.

**Files:**
- `attack-lab-results-paypal-merchant-check.json`: legit and price-change, with the merchant-side check.
- `attack-lab-results-paypal-swapped-payee.json`: the swapped-payee attack. Errand's message there ("…did go through") was wrong, since the buyer had only approved and nothing was captured. It now says "I approved the PayPal sandbox payment…, but the shop didn't confirm taking it".
- `before-merchant-check-legit.json` and `before-merchant-check-first-run.json`: the held runs from before the fix.

Registered emails appear masked in these files.
