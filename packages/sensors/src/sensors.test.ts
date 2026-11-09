import { describe, expect, it } from "vitest";
import { type Embedder, SensorCache, loadEmbedder } from "./index.js";

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

  // A stand-in model that records each batch and answers when told to.
  const fake = () => {
    const batches: string[][] = [];
    const release: (() => void)[] = [];
    const e: Embedder = {
      model: { sha256: "a".repeat(64) } as never,
      embed: (texts) => {
        batches.push(texts);
        return new Promise((ok) => release.push(() => ok(texts.map(() => [1, 0]))));
      },
    };
    return { e, batches, release };
  };

  it("caps the texts and characters one call can embed", async () => {
    const f = fake();
    const cache = new SensorCache(f.e, 100, { textsPerCall: 2, charsPerText: 5, queued: 8 });
    const p = cache.vectors(["aaaaaaaa", "b", "c"], 1000);
    await Promise.resolve();
    await Promise.resolve();
    f.release[0]!();
    const v = await p;
    expect(f.batches).toEqual([["aaaaa", "b"]]);
    expect([...v.vectors.keys()]).toEqual(["aaaaaaaa", "b"]);
  });

  it("keeps a timed-out batch's vectors, and does not embed a text twice while it runs", async () => {
    const f = fake();
    const cache = new SensorCache(f.e);
    expect((await cache.vectors(["x"], 10)).vectors.size).toBe(0);
    const again = cache.vectors(["x"], 1000);
    f.release[0]!();
    expect((await again).vectors.get("x")).toEqual([1, 0]);
    expect(f.batches).toEqual([["x"]]);
  });

  it("leaves texts out at once when too many batches are waiting", async () => {
    const f = fake();
    const cache = new SensorCache(f.e, 100, { textsPerCall: 32, charsPerText: 1000, queued: 1 });
    void cache.vectors(["a"], 10); // running
    await Promise.resolve();
    void cache.vectors(["b"], 10); // waiting: the queue is full
    const start = Date.now();
    const full = await cache.vectors(["c"], 5000);
    expect(full.vectors.size).toBe(0);
    expect(Date.now() - start).toBeLessThan(1000);
    expect(f.batches).toEqual([["a"]]);
  });
});
