import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ClaimSensor, SensorVectors } from "@mwf/core";
import { env, pipeline } from "@huggingface/transformers";

// The embedding model behind the claim sensors, run in-process with ONNX Runtime
// (transformers.js). Sentence embeddings only: no generative model is involved.
//
// The model is pinned by repository revision and by the hash of its ONNX file. A file whose hash
// differs is refused, so every decision's sensor score names exactly the weights that made it.

export interface ModelSpec {
  name: string;
  revision: string;
  file: string;
  sha256: string;
  pooling: "mean" | "cls";
  dim: number;
}

// all-MiniLM-L6-v2 (Apache-2.0), 8-bit quantized ONNX, 23 MB, 384 dimensions.
export const MINILM: ModelSpec = {
  name: "Xenova/all-MiniLM-L6-v2",
  revision: "751bff37182d3f1213fa05d7196b954e230abad9",
  file: "onnx/model_quantized.onnx",
  sha256: "afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1",
  pooling: "mean",
  dim: 384,
};

export const DEFAULT_CACHE = resolve(import.meta.dirname, "../../../.cache/models");

export interface Embedder {
  model: ModelSpec;
  embed(texts: string[]): Promise<number[][]>;
}

const sha256File = (path: string) =>
  new Promise<string>((ok, fail) => {
    const h = createHash("sha256");
    createReadStream(path).on("data", (d) => h.update(d)).on("end", () => ok(h.digest("hex"))).on("error", fail);
  });

// Loads the model. `download: false` uses the local cache only (MWF_SENSORS_DOWNLOAD=0 in prod
// images that bake the model in). Throws if the file's hash is not the pinned one.
export async function loadEmbedder(model: ModelSpec = MINILM, { cacheDir = process.env.MWF_MODEL_CACHE ?? DEFAULT_CACHE, download = process.env.MWF_SENSORS_DOWNLOAD !== "0" } = {}): Promise<Embedder> {
  env.cacheDir = cacheDir;
  env.allowRemoteModels = download;
  env.allowLocalModels = false;
  const extractor = await pipeline("feature-extraction", model.name, { revision: model.revision, dtype: "q8" });
  const path = join(cacheDir, model.name, model.file);
  if (!existsSync(path)) throw new Error(`model file not found at ${path}`);
  const actual = await sha256File(path);
  if (actual !== model.sha256) throw new Error(`model ${model.name} has hash ${actual}, expected ${model.sha256}`);
  return {
    model,
    async embed(texts) {
      if (texts.length === 0) return [];
      const out = await extractor(texts, { pooling: model.pooling, normalize: true });
      return out.tolist() as number[][];
    },
  };
}

export const specOf = (sensor: ClaimSensor): ModelSpec => sensor.model;

// Bounds on the work one call can cause. Over them, texts are left out (fail closed), so a page
// stuffed with claims cannot make the model the bottleneck for everyone.
export const SENSOR_LIMITS = {
  // Claim texts embedded per call; the rest are left out.
  textsPerCall: 32,
  // Characters of a claim the model reads (MiniLM reads 256 tokens at most anyway).
  charsPerText: 1000,
  // Batches waiting for the model; a call that would wait behind more is left out at once.
  queued: 8,
};

// Embeds `texts` for checkAction. Vectors already computed are reused. Batches run one at a time,
// so the model never works on more than one; a text already being embedded is not embedded
// again. On a timeout, a full queue or an error the vectors are left out, and an enforced sensor
// holds the claim for REVIEW (fail closed). A batch that times out still finishes and fills the
// cache, so a retry is cheap.
export class SensorCache {
  private cache = new Map<string, number[]>();
  private inflight = new Map<string, Promise<void>>();
  private tail: Promise<void> = Promise.resolve();
  private waiting = 0;
  constructor(
    private embedder: Embedder,
    private max = 5000,
    private limits = SENSOR_LIMITS,
  ) {}

  get model_sha256() {
    return this.embedder.model.sha256;
  }

  private store(texts: string[], vs: number[][]) {
    texts.forEach((t, i) => this.cache.set(t, vs[i]!));
    while (this.cache.size > this.max) this.cache.delete(this.cache.keys().next().value!);
  }

  // Queues one batch behind the running one. Returns null when the queue is full.
  private enqueue(texts: string[]): Promise<void> | null {
    if (this.waiting >= this.limits.queued) return null;
    this.waiting++;
    const run = this.tail.then(async () => {
      this.waiting--;
      try {
        this.store(texts, await this.embedder.embed(texts.map((t) => t.slice(0, this.limits.charsPerText))));
      } catch {
        // Left out; the engine treats an unscored claim as unavailable.
      } finally {
        for (const t of texts) this.inflight.delete(t);
      }
    });
    this.tail = run;
    for (const t of texts) this.inflight.set(t, run);
    return run;
  }

  async vectors(texts: string[], timeoutMs = 2000): Promise<SensorVectors> {
    const wanted = [...new Set(texts)].slice(0, this.limits.textsPerCall);
    const missing = wanted.filter((t) => !this.cache.has(t) && !this.inflight.has(t));
    if (missing.length) this.enqueue(missing);
    const pending = [...new Set(wanted.map((t) => this.inflight.get(t)).filter((p) => p !== undefined))];
    if (pending.length) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([Promise.all(pending), new Promise<void>((ok) => (timer = setTimeout(ok, timeoutMs)))]);
      clearTimeout(timer);
    }
    const vectors = new Map<string, number[]>();
    for (const t of wanted) {
      const v = this.cache.get(t);
      if (v) vectors.set(t, v);
    }
    return { model_sha256: this.model_sha256, vectors };
  }
}
