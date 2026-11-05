import { z } from "zod";

// The agent's brain, behind one interface: given what has happened so far, the next step.
// The agent is the attack victim, not part of the firewall. Which model drives it is an open
// decision (docs/architecture.md); for now a deterministic stand-in does (naive.ts).

const Price = z.strictObject({ value: z.string(), currency: z.string() });

export const PurchaseInput = z.strictObject({
  merchant: z.strictObject({ id: z.string(), name: z.string(), payee_email: z.string().optional() }),
  items: z
    .array(z.strictObject({ sku: z.string(), name: z.string(), category: z.string(), unit_price: Price, quantity: z.number().int().min(1) }))
    .min(1),
});
export type PurchaseInput = z.infer<typeof PurchaseInput>;

// A model's output is untrusted input: the loop validates every call against this.
export const ToolCall = z.discriminatedUnion("tool", [
  z.strictObject({ tool: z.literal("browse"), url: z.string() }),
  z.strictObject({ tool: z.literal("propose_purchase"), input: PurchaseInput }),
]);
export type ToolCall = z.infer<typeof ToolCall>;

export type ModelTurn = { type: "call"; call: unknown } | { type: "final"; text: string };

export type HistoryEntry = { role: "task"; text: string } | { role: "model"; turn: ModelTurn } | { role: "tool"; result: unknown };

export interface ModelInput {
  system: string;
  history: HistoryEntry[];
}

export interface Model {
  next(input: ModelInput): Promise<ModelTurn>;
}

// Plays back a fixed list of turns. For tests, including a compromised agent's.
export class ScriptedModel implements Model {
  #at = 0;
  constructor(private readonly turns: ModelTurn[]) {}

  async next(): Promise<ModelTurn> {
    return this.turns[this.#at++] ?? { type: "final", text: "Done." };
  }
}
