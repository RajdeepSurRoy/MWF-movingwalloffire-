# LLM Budget Plan — staying inside the Gemini free tier

MWF uses Gemini free-tier keys. The free tier is limited (requests per minute, per day, tokens per minute — see the **Rate Limit** page in Google AI Studio for current numbers), so every LLM call has to earn its place. This doc is the rulebook for development, testing and the demo.

**Goal:** the full test battery and almost all development run with **zero** live Gemini calls. Live calls happen only when something new needs an answer, and on stage.

---

## Where the LLM is used (and where it isn't)

| Component | Uses Gemini? | Notes |
|---|---|---|
| Mandate, spending policy, merchant allowlist, integrity hash | **No** | Deterministic code |
| Injection scanner (hidden CSS, zero-width chars, comments, phrases) | **No** | Deterministic code |
| Semantic intent classifier | Yes — 1 call per proposal, only when needed | Boolean flags only |
| Shopping agent | Yes — only in the demo and a few end-to-end runs | Tests feed proposals directly; no agent needed |
| Red-team attack variations | Yes — in batches, results saved as fixtures | Most mutations are deterministic and free |
| Test grading | **No** | Expected vs actual, deterministic |

---

## The rules

### 1. Deterministic checks run first — the LLM is the last resort
The classifier is only called if every deterministic check has already passed. If the mandate, policy, merchant or injection scan already says BLOCK, the decision can't get looser, so asking the AI would waste a call. Most attacks never reach Gemini.

### 2. Record once, replay forever
Every classifier call goes through one wrapper with three modes, set by `LLM_MODE` in `.env`:

| Mode | Behaviour | When |
|---|---|---|
| `replay` (default) | Answer from the cache; **fail loudly** on a cache miss, never call the API | Tests, CI, day-to-day dev |
| `record` | Use the cache; on a miss call Gemini and save the answer | Adding new test cases |
| `live` | Always call Gemini (still saves the answer) | The demo, spot checks |

- Cache key = SHA-256 of `model + prompt version + compact input`. Change the prompt → bump the version → only the affected cases get re-recorded.
- The cache is committed to the repo (`fixtures/llm-cache/`), so both teammates share one set of recordings and nobody re-spends calls on the same input.
- This also makes grading repeatable, which the brief requires anyway.

### 3. Send the minimum, not the page
Never send raw HTML. Send:
- the mandate and cart as **compact JSON** (short keys, no whitespace),
- only the **relevant text snippets** from the page (product title, description, anything the scanner flagged), **truncated to a fixed character cap**,
- the deterministic scanner's findings as short codes, so the model doesn't have to rediscover them.

### 4. Keep the output tiny
- `responseMimeType: application/json` with a `responseSchema` of booleans only — the answer is a handful of tokens.
- Short property names in the schema (mapped back to full names in code).
- Low `maxOutputTokens`.
- **Turn thinking down** (`thinkingConfig`). On Gemini 3.x, hidden "thinking" tokens can cost far more than the answer itself — see the measurements below.

### 5. One call per proposal
All flags (`cart_explained_by_intent`, `injection_suspected`, `persuasion_detected`) come back from a single call. Never one call per flag.

### 6. Short, fixed system prompt
A few lines, versioned in code. No examples in the prompt unless measurement shows they're needed for accuracy.

### 7. The agent is optional in tests
Firewall tests are made of payment proposals; they don't need an agent to produce them. The real agent runs only in the demo and a handful of end-to-end tests — and those runs are recorded too.

### 8. Red-team: free mutations first, LLM in batches
- Most attack variations are deterministic transforms and cost nothing: hide text with CSS, insert zero-width characters, move it into an HTML comment or meta tag, swap merchant names for lookalikes, change amounts.
- When an LLM is needed for creative wording, ask for **many variations in one call** (e.g. 20 at once) and save them as fixtures. They then become permanent tests that replay for free.

### 9. Guard rails in the client
- A local request limiter that stays below the free-tier per-minute limit.
- A daily call counter written to a local file; stop at a safe margin below the daily limit.
- Log tokens used per call (from `usageMetadata`) so the budget is visible, not guessed.
- On a rate-limit error: back off and retry once, then fail closed — the firewall treats "classifier unavailable" as **REVIEW**, never ALLOW.

### 10. Demo day
- Use a separate key (ideally a different Google account → its own quota) that is **not touched** in the days before.
- Live calls only for the 2–3 demo steps that need them; everything else replays.
- A full recorded replay of the demo as backup in case of a rate limit or network problem.

---

## Model choice

| Use | Model | Why |
|---|---|---|
| Classifier | `gemini-3.5-flash` (pinned version) | Fixed behaviour; `-latest` aliases can change under us mid-hackathon |
| If accuracy holds | `gemini-3.5-flash-lite` | Cheaper and usually higher free limits — switch only if the test battery shows no accuracy loss |

Model and prompt version live in `.env` / code constants, and both are part of the cache key.

---

## Measurements

Same compact classifier prompt (the "headphones are a required project expense" attack), measured on 2026-10-29 with our free-tier key:

| Model | Thinking | Prompt tokens | Thinking tokens | Answer tokens | **Total** | Answer |
|---|---|---|---|---|---|---|
| `gemini-3.5-flash` | default | 48 | 190 | 6 | **244** | ❌ **none** — thinking used up the 200-token output cap |
| `gemini-3.5-flash` | `minimal` | 48 | 0 | 13 | **61** | ✅ `e:false, i:true, p:true` (correct) |
| `gemini-3.5-flash-lite` | `minimal` | 48 | 0 | 15 | **63** | ⚠️ `e:true` — wrongly said the headphones fit "AA batteries" |

What this tells us:

- **Set `thinkingLevel: "minimal"` on every classifier call.** It cut the call from 244 to 61 tokens (−75%), and the answer was still correct.
- **Thinking tokens count against `maxOutputTokens`.** With default thinking and a small cap, the model can spend the whole budget thinking and return *no answer*. Our code must treat an empty or unparseable answer as "classifier unavailable" → **REVIEW**, never ALLOW.
- **Stay on `gemini-3.5-flash`, not `-lite`, for now.** Lite got the key flag wrong on this case. That's one sample, so re-check on the full test battery before deciding — but it's a warning.
- Calls took 2–3 seconds each, so speed is fine for the demo.
- At ~60 tokens a call, token limits won't be the problem — the **requests-per-minute and requests-per-day** limits will. That's why record/replay (rule 2) matters most.
