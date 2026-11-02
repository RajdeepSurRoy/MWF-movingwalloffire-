import Fastify from "fastify";
import { DEFAULT_DECISION } from "@mwf/core";

// The five checkpoint endpoints are added in milestone M1; until then the
// server only reports health and the decision it falls back to.
export function buildApp() {
  const app = Fastify({ logger: false });

  app.get("/healthz", async () => ({ ok: true, failClosedDecision: DEFAULT_DECISION }));

  return app;
}
