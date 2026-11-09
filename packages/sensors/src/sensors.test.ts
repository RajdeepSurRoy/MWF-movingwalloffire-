import { describe, expect, it } from "vitest";
import { SensorCache, loadEmbedder } from "./index.js";

// Needs the model file (downloaded on first use, ~23 MB). Set MWF_SENSORS_DOWNLOAD=0 offline:
// the test then fails if the model is not cached, rather than passing without it.
describe("embedder", () => {
  it("loads the pinned model, checks its hash and embeds", async () => {
    const e = await loadEmbedder();
    const [a, b, c] = await e.embed(["this product is what the pros use", "insiders agree this product beats every alternative", "this product ships in 2 business days"]);
    expect(a).toHaveLength(384);
    const dot = (x: number[], y: number[]) => x.reduce((s, v, i) => s + v * y[i]!, 0);
    expect(dot(a!, b!)).toBeGreaterThan(dot(a!, c!));
  }, 120_000);

  it("refuses a model file with another hash", async () => {
    await expect(loadEmbedder({ name: "Xenova/all-MiniLM-L6-v2", revision: "751bff37182d3f1213fa05d7196b954e230abad9", file: "onnx/model_quantized.onnx", sha256: "0".repeat(64), pooling: "mean", dim: 384 })).rejects.toThrow(/expected/);
  }, 120_000);

  it("leaves vectors out when the model times out", async () => {
    const slow = { model: { sha256: "a".repeat(64) } as never, embed: () => new Promise<number[][]>(() => {}) };
    const v = await new SensorCache(slow).vectors(["x y z"], 20);
    expect(v.vectors.size).toBe(0);
  });
});
