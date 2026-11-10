# MWF roadmap after the hackathon

The hackathon build protects one kind of agent action: payments. After the hackathon (Nov 15, 2026), MWF becomes a product: **security for AI agents**. Any agentic tool, workflow or system calls MWF with its own API key, and MWF checks every step.

The shape stays the same as today:
- Five checkpoints: intent, context, action, commit, output.
- A deterministic policy makes every decision; models can only tighten it.
- MWF never executes actions and never touches customer data.
- Learning is global, but only learned patterns are shared between customers, never their data.

What changes is breadth.

## 1. Integration

Adoption depends on how easy MWF is to switch on.

- SDKs for TypeScript and Python.
- Adapters for common agent frameworks:
  - MCP
  - LangChain / LangGraph
  - OpenAI Agents SDK
  - Claude Agent SDK
- **MCP gateway mode:** MWF sits in front of a team's tool servers, so it can be switched on without changing agent code.
- Generic action types beyond payments, each with its own checks:
  - HTTP egress
  - email
  - files
  - shell
  - database
  - admin APIs

## 2. Attack coverage

Today MWF covers prompt injection and payment manipulation. Next:

| Attack | What it means |
|---|---|
| Data exfiltration | The agent sends secrets or customer data to an outside URL, email or tool |
| Tool poisoning | A malicious tool description (for example, in MCP) steers the agent |
| Goal hijacking | The agent drifts from the user's stated intent |
| Privilege misuse | Shell, file, database or admin calls outside the agent's role |
| Memory poisoning | A planted "fact" in long-term memory steers later runs |
| Runaway agents | Loops, cost explosions, mass actions |
| Output leaks | Personal data or secrets in the final answer |
| Multi-agent confusion | One agent tricks another into acting |

Each new attack type follows the existing loop: fixtures and red-team seeds, then rules or sensors, then backtest, shadow and enforce, with human approval.

## 3. Business model

- **Pay as you go:** price per checkpoint call, with a free monthly allowance.
- Higher tiers add:
  - the global learning network
  - longer audit retention
  - custom policies
  - support
- Self-serve sign-up, key management in the dashboard, usage metering and billing.

## 4. Interface

The console grows into the product's main screen:
- onboarding and API keys
- usage and billing
- live decisions and attack paths
- approving held actions
- rule and sensor review
- per-customer policies

A proper documentation site and an improved frontend follow once design partners are using it.

## 5. Production infrastructure

- PostgreSQL instead of SQLite.
- Page rendering as a separate, sandboxed service.
- Hosting in more than one region.
- A latency target of under 50 ms per check.
- Monitoring and status pages.

## 6. Trust

- A clear statement of what is stored, plus a no-retention option.
- An explanation of how cross-customer learning works: patterns only, opt-in, corroborated by several customers before going global.
- A path to SOC 2.

## First steps after Nov 15

1. Find 3–5 design partners: teams running agents in production who will use MWF for free and report what they see.
2. Build in this order:
   1. integration (SDKs and the MCP gateway)
   2. the two or three attack types those partners face most
   3. sign-up and billing
3. Improve the frontend once partners use it every day.
