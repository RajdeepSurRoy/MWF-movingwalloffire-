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

// Embeds `texts` for checkAction. Vectors already computed are reused. On a timeout or error the
// vectors are left out, and an enforced sensor holds the claim for REVIEW (fail closed).
export class SensorCache {
  private cache = new Map<string, number[]>();
  constructor(
    private embedder: Embedder,
    private max = 5000,
  ) {}

  get model_sha256() {
    return this.embedder.model.sha256;
  }

  async vectors(texts: string[], timeoutMs = 2000): Promise<SensorVectors> {
    const missing = [...new Set(texts.filter((t) => !this.cache.has(t)))];
    if (missing.length) {
      let timer: NodeJS.Timeout | undefined;
      try {
        const vs = await Promise.race([
          this.embedder.embed(missing),
          new Promise<never>((_, fail) => (timer = setTimeout(() => fail(new Error("sensor timeout")), timeoutMs))),
        ]);
        missing.forEach((t, i) => this.cache.set(t, vs[i]!));
        while (this.cache.size > this.max) this.cache.delete(this.cache.keys().next().value!);
      } catch {
        // Left out: the engine treats an unscored claim as unavailable.
      } finally {
        clearTimeout(timer);
      }
    }
    const vectors = new Map<string, number[]>();
    for (const t of texts) {
      const v = this.cache.get(t);
      if (v) vectors.set(t, v);
    }
    return { model_sha256: this.model_sha256, vectors };
  }
}
