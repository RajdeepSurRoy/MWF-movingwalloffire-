import { type Claim, findClaims } from "./claims.js";
import type { RuleBundle } from "./rules.js";
import { analyzeContext } from "./scan.js";
import { type ContextItem, PaymentArgs, type ProposedAction, type Reason } from "./schemas.js";

// Embedding sensors (M7). A learned phrase covers the wording it was learned from; a claim in new
// words ("insiders agree X beats every alternative") gets past it. The sensor reads a claim's
// meaning instead: a pinned sentence-embedding model turns the claim into a vector, and a linear
// classifier trained by the red team scores it. A score at or above the threshold holds the
// action for REVIEW. The sensor never allows anything and never blocks.
//
// The model runs outside this package (packages/sensors), because it is asynchronous and large.
// The caller asks for the texts to embed (sensorTexts), embeds them, and passes the vectors in.
// This file only does the arithmetic, so the decision stays synchronous and reproducible.

export type ClaimSensor = RuleBundle["claim_sensors"][number];

// Vectors for claim texts, from the model with this file hash.
export interface SensorVectors {
  model_sha256: string;
  vectors: Map<string, readonly number[]>;
}

export interface SensorScore {
  sensor_id: string;
  model_sha256: string;
  ref: string;
  sku: string;
  // null: no vector for the claim (model down, timed out, or a different model).
  score: number | null;
}

// What the sensor reads: the claim with the item's name replaced, so the score is about what the
// page says, not which product it names.
export const sensorText = (claim: Pick<Claim, "skeleton">) => claim.skeleton.map((w) => (w === "<item>" ? "this product" : w)).join(" ");

interface ItemClaim {
  item: ContextItem;
  sku: string;
  name: string;
  claim: Claim;
}

function itemClaims(items: ContextItem[], texts: string[][], action: ProposedAction): ItemClaim[] {
  if (!action.type.startsWith("payment.")) return [];
  const parsed = PaymentArgs.safeParse(action.args);
  if (!parsed.success) return [];
  const out: ItemClaim[] = [];
  items.forEach((item, k) => {
    if (item.trust === "trusted") return;
    for (const line of parsed.data.items) {
      for (const claim of findClaims(item.id, texts[k] ?? [], line.sku, line.name)) out.push({ item, sku: line.sku, name: line.name, claim });
    }
  });
  return out;
}

// The texts of the claims about the action's items, as a sensor reads them. The red team trains
// on these.
export function claimSensorTexts(input: { context: ContextItem[]; action: ProposedAction }, bundle: RuleBundle): string[] {
  const texts = analyzeContext(input.context, bundle, undefined, true).map((a) => a.texts ?? []);
  return [...new Set(itemClaims(input.context, texts, input.action).map((c) => sensorText(c.claim)))];
}

// The texts the caller must embed before checkAction, when the bundle has a sensor.
export const sensorTexts = (input: { context: ContextItem[]; action: ProposedAction }, bundle: RuleBundle): string[] =>
  bundle.claim_sensors.length === 0 ? [] : claimSensorTexts(input, bundle);

export function sensorScore(sensor: ClaimSensor, vector: readonly number[]): number {
  let z = sensor.bias;
  for (let i = 0; i < sensor.weights.length; i++) z += sensor.weights[i]! * (vector[i] ?? 0);
  return 1 / (1 + Math.exp(-z));
}

export interface SensorVerdicts {
  enforced: Reason[];
  shadow: Reason[];
  scores: SensorScore[];
}

// Runs the bundle's sensors over the claims about the action's items. A claim that cannot be
// scored (no vectors, or vectors from another model) is held by an enforced sensor: the sensor
// fails closed, but only for actions where an untrusted page makes a claim about what is bought.
export function checkSensors(
  items: ContextItem[],
  texts: string[][],
  action: ProposedAction,
  bundle: RuleBundle,
  sensors: SensorVectors | undefined,
): SensorVerdicts {
  const out: SensorVerdicts = { enforced: [], shadow: [], scores: [] };
  if (bundle.claim_sensors.length === 0) return out;
  const claims = itemClaims(items, texts, action);
  const seen = new Set<string>();
  for (const sensor of bundle.claim_sensors) {
    const sameModel = sensors?.model_sha256 === sensor.model.sha256;
    for (const { item, sku, name, claim } of claims) {
      const vector = sameModel ? sensors!.vectors.get(sensorText(claim)) : undefined;
      const score = vector && vector.length === sensor.model.dim ? sensorScore(sensor, vector) : null;
      out.scores.push({ sensor_id: sensor.id, model_sha256: sensor.model.sha256, ref: item.id, sku, score: score === null ? null : Math.round(score * 1e4) / 1e4 });
      const key = `${sensor.id}|${sku}|${item.id}`;
      if (seen.has(key)) continue;
      let r: Reason | null = null;
      if (score === null) {
        r = { rule_id: "SEN.UNAVAILABLE", message: `Sensor ${sensor.id} could not score a claim about "${name}" (model ${sensor.model.name} not available): "${claim.excerpt}"`, ref: item.id };
      } else if (score >= sensor.threshold) {
        r = { rule_id: sensor.id, message: `"${name}" is promoted by a claim the persuasion sensor scores ${score.toFixed(2)} (threshold ${sensor.threshold}): "${claim.excerpt}"`, ref: item.id };
      }
      if (!r) continue;
      seen.add(key);
      (sensor.state === "enforced" ? out.enforced : out.shadow).push(r);
    }
  }
  return out;
}
