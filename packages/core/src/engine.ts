import { DEFAULT_DECISION } from "./decision.js";
import type { ContextItem, DecisionResult, Mandate, ProposedAction } from "./schemas.js";

export const POLICY_VERSION = "0.0.0";
export const RULE_BUNDLE_VERSION = "0.0.0";

export interface ActionCheckInput {
  mandate: Mandate;
  context: ContextItem[];
  action: ProposedAction;
  now: Date;
}

export interface CommitCheckInput {
  approvedActionHash: string;
  executedAction: ProposedAction;
  alreadyCommitted: boolean;
}

const NOT_IMPLEMENTED: DecisionResult = {
  decision: DEFAULT_DECISION,
  reasons: [{ rule_id: "ENGINE.NOT_IMPLEMENTED", message: "No rules yet (M2); failing closed to REVIEW" }],
};

// Checkpoint 3 — the only place ALLOW will be decided. Rules arrive in M2.
export function checkAction(_input: ActionCheckInput): DecisionResult {
  return NOT_IMPLEMENTED;
}

// Checkpoint 4 — the executed action must hash to the approved one. Arrives in M2.
export function checkCommit(_input: CommitCheckInput): DecisionResult {
  return NOT_IMPLEMENTED;
}
