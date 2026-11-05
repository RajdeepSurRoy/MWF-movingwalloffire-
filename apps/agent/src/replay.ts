import { hashCanonical } from "@mwf/core";
import type { Model, ModelInput, ModelTurn } from "./model.js";

// Record a run once, replay it without calling the model. Each turn is stored with a hash of
// what the model had seen, so a replay fails loudly the moment the world differs from the
// recording, instead of quietly testing something else. The system prompt is left out of the
// hash: it holds the session's random canary.

export interface Recording {
  version: 1;
  turns: { seen: string; turn: ModelTurn }[];
}

const seen = ({ history }: ModelInput) => hashCanonical(JSON.parse(JSON.stringify(history)));

export class RecordingModel implements Model {
  readonly recording: Recording = { version: 1, turns: [] };
  constructor(private readonly inner: Model) {}

  async next(input: ModelInput): Promise<ModelTurn> {
    const hash = seen(input);
    const turn = await this.inner.next(input);
    this.recording.turns.push({ seen: hash, turn });
    return turn;
  }
}

export class ReplayDivergence extends Error {
  constructor(step: number) {
    super(`the run no longer matches the recording at step ${step}`);
    this.name = "ReplayDivergence";
  }
}

export class ReplayModel implements Model {
  #at = 0;
  constructor(private readonly recording: Recording) {}

  async next(input: ModelInput): Promise<ModelTurn> {
    const entry = this.recording.turns[this.#at];
    if (!entry || entry.seen !== seen(input)) throw new ReplayDivergence(this.#at);
    this.#at++;
    return entry.turn;
  }
}
