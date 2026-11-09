import { readFileSync } from "node:fs";
import { type ClaimSensor, type RuleBundle, type SensorVectors, type TestCase, claimSensorTexts, claimTokens } from "@mwf/core";
import type { Embedder } from "@mwf/sensors";

// Level 3 with embeddings (M7): a persuasion sensor trained from the red team's attacks.
//
// Positives: the claims about the bought item in attacks that got through (seeds and variants).
// Negatives: ordinary product copy that names a product (data/product-copy.txt) and ordinary shop
// text (data/benign.txt). Every other negative is held out of training to set the threshold:
// the threshold sits above the highest-scoring held-out negative, so none of them would be held.
// The classifier is logistic regression on the embedding: a few hundred weights, trained in a
// second, deterministic, and readable.

const lines = (path: string) =>
  readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim() && !l.startsWith("#"));

// Product copy as the sensor sees a claim: the product's name replaced, words normalized.
export const copyText = (line: string) =>
  claimTokens(line.replace(/\{item\}/g, " itemplaceholder "))
    .map((w) => (w === "itemplaceholder" ? "this product" : w))
    .join(" ");

export function negatives(copyPath: string, benignPath: string): { train: string[]; calibrate: string[] } {
  const copy = [...new Set(lines(copyPath).map(copyText))];
  const benign = [...new Set(lines(benignPath).map((l) => claimTokens(l).join(" ")))];
  const split = (xs: string[], odd: boolean) => xs.filter((_, i) => i % 2 === (odd ? 1 : 0));
  return { train: [...split(copy, false), ...split(benign, false)], calibrate: [...split(copy, true), ...split(benign, true)] };
}

// The claim texts in the cases (attack claims about the bought item, or legitimate pages' claims).
export const caseTexts = (cases: TestCase[], bundle: RuleBundle) => [...new Set(cases.flatMap((c) => claimSensorTexts(c, bundle)))];

// Vectors for every claim text in `cases`, for runs and backtests.
export async function vectorsFor(embedder: Embedder, cases: TestCase[], bundle: RuleBundle, extra: string[] = []): Promise<SensorVectors> {
  const texts = [...new Set([...caseTexts(cases, bundle), ...extra])];
  const vs = await embedder.embed(texts);
  return { model_sha256: embedder.model.sha256, vectors: new Map(texts.map((t, i) => [t, vs[i]!])) };
}

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

// Class-balanced logistic regression with L2, full-batch gradient descent: same data, same weights.
export function fit(pos: number[][], neg: number[][], { epochs = 2000, rate = 0.5, l2 = 0.01 } = {}) {
  const X = [...pos, ...neg];
  const y = [...pos.map(() => 1), ...neg.map(() => 0)];
  const d = X[0]!.length;
  const w = new Array<number>(d).fill(0);
  let b = 0;
  const wp = X.length / (2 * pos.length);
  const wn = X.length / (2 * neg.length);
  for (let ep = 0; ep < epochs; ep++) {
    const g = new Array<number>(d).fill(0);
    let gb = 0;
    for (let n = 0; n < X.length; n++) {
      const x = X[n]!;
      let z = b;
      for (let i = 0; i < d; i++) z += w[i]! * x[i]!;
      const e = (sigmoid(z) - y[n]!) * (y[n] ? wp : wn);
      for (let i = 0; i < d; i++) g[i]! += e * x[i]!;
      gb += e;
    }
    for (let i = 0; i < d; i++) w[i]! -= rate * (g[i]! / X.length + l2 * w[i]!);
    b -= (rate * gb) / X.length;
  }
  const r = (v: number) => Math.round(v * 1e5) / 1e5;
  return { weights: w.map(r), bias: r(b) };
}

export interface SensorCandidate {
  sensor: ClaimSensor;
  calibration_scores: number[];
}

// Trains a sensor on attack claims, sets its threshold on the held-out negatives.
export async function trainSensor(embedder: Embedder, positives: string[], neg: { train: string[]; calibrate: string[] }, id: string): Promise<SensorCandidate> {
  const pos = [...new Set(positives)];
  if (pos.length === 0) throw new Error("no attack claims to train on");
  const [P, N, C] = [await embedder.embed(pos), await embedder.embed(neg.train), await embedder.embed(neg.calibrate)];
  const { weights, bias } = fit(P, N);
  const score = (v: number[]) => sigmoid(v.reduce((s, x, i) => s + x * weights[i]!, bias));
  const cal = C.map(score).sort((a, b) => b - a);
  const max = cal[0] ?? 0;
  // Above every held-out negative, with a margin, and never below one half.
  const threshold = Math.min(0.99, Math.max(0.5, Math.ceil((max + 0.01) * 100) / 100));
  const m = embedder.model;
  return {
    calibration_scores: cal,
    sensor: {
      id,
      description: "Persuasion sensor: a claim on an untrusted page about the bought item reads like the red team's persuasion attacks (embedding classifier).",
      state: "shadow",
      model: { name: m.name, revision: m.revision, file: m.file, sha256: m.sha256, pooling: m.pooling, dim: m.dim },
      weights,
      bias,
      threshold,
      learned: {
        positives: pos.length,
        negatives: neg.train.length,
        calibration: { negatives: C.length, above_threshold: cal.filter((s) => s >= threshold).length, max_score: Math.round(max * 1e4) / 1e4 },
        backtest: { caught: 0, of: 0, legit_broken: 0, weakened: 0 },
        approved_by: "",
        approved_at: new Date(0).toISOString(),
      },
    },
  };
}

