// Downloads and verifies the sensor model at image build time, so the running container needs no
// Internet access. The model is pinned by revision and file hash (see packages/sensors).
import { loadEmbedder } from "@mwf/sensors";

await loadEmbedder();
console.log("Sensor model cached.");
