import { type ContextItem, DecisionValue, type Mandate, type ProposedAction, Reason } from "@mwf/core";
import { z } from "zod";

// The HTTP client for the firewall API. Anything other than a well-formed answer is a thrown
// FirewallError, never a default: the caller must treat it as "not allowed".

const Verdict = z.object({
  decision_id: z.string(),
  decision: DecisionValue,
  reasons: z.array(Reason),
  graph_path: z.array(z.string()).optional(),
});
export type Verdict = z.infer<typeof Verdict>;

const SessionAnswer = Verdict.extend({ session_id: z.string(), mandate_hash: z.string(), canary: z.string() });
const InspectAnswer = Verdict.extend({ items: z.array(z.object({ id: z.string(), quarantined: z.boolean() })) });
const CheckAnswer = Verdict.extend({
  action_hash: z.string(),
  action_token: z.string().nullable(),
  idempotency_key: z.string().optional(),
  expires_at: z.string().optional(),
});

export type InspectResult = z.infer<typeof InspectAnswer>;

// What an ALLOW carries: the single-use token and the exact action it was issued for.
export interface Approval {
  token: string;
  action: ProposedAction;
  idempotencyKey: string;
  expiresAt: string;
}

export type CheckResult = Verdict & { approval: Approval | null };

export class FirewallError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "FirewallError";
  }
}

export interface FirewallOptions {
  baseUrl: string;
  apiKey: string;
  fetch?: typeof globalThis.fetch;
  // Long enough for a page render at /v1/context/inspect.
  timeoutMs?: number;
}

export class FirewallClient {
  readonly #base: string;
  readonly #key: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #timeoutMs: number;

  constructor({ baseUrl, apiKey, fetch = globalThis.fetch, timeoutMs = 60_000 }: FirewallOptions) {
    this.#base = baseUrl.replace(/\/+$/, "");
    this.#key = apiKey;
    this.#fetch = fetch;
    this.#timeoutMs = timeoutMs;
  }

  // Internal to the SDK. Errors name the path and status only: never the key or the body.
  async post<T>(path: string, body: unknown, schema: z.ZodType<T>): Promise<T> {
    let res: Response;
    try {
      res = await this.#fetch(this.#base + path, {
        method: "POST",
        headers: { authorization: `Bearer ${this.#key}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (cause) {
      throw new FirewallError(`could not reach the firewall at ${path}`, undefined, { cause });
    }
    if (!res.ok) throw new FirewallError(`the firewall answered ${res.status} at ${path}`, res.status);
    const parsed = schema.safeParse(await res.json().catch(() => undefined));
    if (!parsed.success) throw new FirewallError(`the firewall gave a malformed answer at ${path}`, res.status);
    return parsed.data;
  }

  async startSession(intent: { prompt: string; mandate: Mandate }): Promise<FirewallSession> {
    const answer = await this.post("/v1/sessions", intent, SessionAnswer);
    return new FirewallSession(this, answer);
  }
}

export class FirewallSession {
  readonly id: string;
  // For the business to plant in the agent's prompt: if it shows up in an action or an output,
  // the prompt is leaking.
  readonly canary: string;
  readonly mandateHash: string;
  readonly intent: Verdict;
  readonly #client: FirewallClient;

  constructor(client: FirewallClient, answer: z.infer<typeof SessionAnswer>) {
    const { session_id, canary, mandate_hash, ...intent } = answer;
    this.#client = client;
    this.id = session_id;
    this.canary = canary;
    this.mandateHash = mandate_hash;
    this.intent = intent;
  }

  inspectContext(items: ContextItem[]): Promise<InspectResult> {
    return this.#client.post("/v1/context/inspect", { session_id: this.id, items }, InspectAnswer);
  }

  async checkAction(action: ProposedAction): Promise<CheckResult> {
    const { action_token, idempotency_key, expires_at, action_hash: _, ...verdict } = await this.#client.post(
      "/v1/actions/check",
      { session_id: this.id, action },
      CheckAnswer,
    );
    const approval =
      verdict.decision === "ALLOW" && action_token && idempotency_key && expires_at
        ? { token: action_token, action, idempotencyKey: idempotency_key, expiresAt: expires_at }
        : null;
    return { ...verdict, approval };
  }

  // `executed` is what is really about to run; it must hash to what was approved.
  commitAction(approval: Approval, executed: ProposedAction = approval.action): Promise<Verdict> {
    return this.#client.post("/v1/actions/commit", { session_id: this.id, action_token: approval.token, action: executed }, Verdict);
  }

  checkOutput(content: string): Promise<Verdict> {
    return this.#client.post("/v1/outputs/check", { session_id: this.id, output: { content } }, Verdict);
  }
}
