// Core of the firewall: schemas, policy engine, provenance graph, ledger, hashing.
// Filled in from milestone M1 onward (see docs/implementation-plan.md).

export const DECISIONS = ["ALLOW", "BLOCK", "REVIEW"] as const;
export type Decision = (typeof DECISIONS)[number];

// Fail closed: anything the firewall cannot decide is held for review, never allowed.
export const DEFAULT_DECISION: Decision = "REVIEW";
