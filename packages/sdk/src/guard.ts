import type { ContextItem, Mandate, PreparedEffect, ProposedAction } from "@mwf/core";
import { type Approval, type FirewallClient, FirewallError, type FirewallSession, type Verdict } from "./client.js";
import { type BrowserPage, type BrowserRequest, type BrowserResponse, pageContextItem, recordStylesheets } from "./page.js";

// The tools an agent gets instead of its own browser and payment access.
//
// The boundary is between the model and the tools: a model can only ask for a tool call, so
// everything it must not decide lives here. It never sees an API key, an action token or a
// decision's reasons, and it cannot choose what is trusted, skip an inspection, or say what it
// read. Inspection comes first: content reaches the agent only after the firewall has seen
// exactly those bytes, and only if it was not quarantined.

// ProposedAction.derived_from holds at most this many ids, so a session reads at most this many
// items: past it, reads could no longer all be declared and a flagged page could be pushed out.
export const MAX_READS = 200;

const ORIGIN_RULE = "SDK.ORIGIN_NOT_ALLOWED";

export interface BrowserRoute {
  request(): { url(): string };
  abort(): Promise<void>;
  fallback(): Promise<void>;
}

export interface BrowserTab extends BrowserPage {
  goto(url: string): Promise<unknown>;
  close(): Promise<void>;
  route(url: string, handler: (route: BrowserRoute) => unknown): Promise<unknown>;
  on(event: "response", listener: (response: BrowserResponse) => void): unknown;
  on(event: "request", listener: (request: BrowserRequest) => void): unknown;
}

export type ReadResult =
  | { status: "ok"; id: string; uri: string | null; content: string }
  | { status: "withheld"; id: string; uri: string | null; rule_ids: string[] }
  | { status: "refused"; rule_ids: string[] }; // the request itself was not sent

// When the outside system had prepared the action, `prepared` says what: cancelled after BLOCK,
// still held after REVIEW (for a person to execute or cancel).
export type ProposalResult<R> =
  | { status: "executed"; receipt: R }
  | { status: "BLOCK" | "REVIEW"; rule_ids: string[]; prepared?: PreparedEffect };

// Two-phase commit for irreversible actions, written by the business with its own systems and
// credentials: prepare without doing (authorize a payment, draft an email, stage a transaction),
// then execute or cancel. The Guard only decides which, from the firewall's answer; it never
// talks to those systems itself.
export interface TwoPhase<R> {
  appliesTo(action: ProposedAction): boolean;
  // What the system reports it has ready, copied from its own answer, never from the model.
  prepare(action: ProposedAction, idempotencyKey: string): Promise<PreparedEffect>;
  execute(prepared: PreparedEffect, action: ProposedAction, idempotencyKey: string): Promise<{ receipt: R; status: string; external_ids?: Record<string, string> }>;
  cancel(prepared: PreparedEffect, idempotencyKey: string): Promise<{ status: string }>;
}

export interface GuardedTools<R> {
  browse(url: string): Promise<ReadResult>;
  propose(type: string, args: Record<string, unknown>): Promise<ProposalResult<R>>;
}

// For the business's own logs and console. Holds reasons that quote attack text: never show the agent.
export interface GuardEvent {
  checkpoint: "intent" | "context" | "action" | "commit" | "output";
  verdict: Verdict;
  item_id?: string;
}

export interface GuardOptions<R> {
  firewall: FirewallClient;
  prompt: string;
  mandate: Mandate;
  openTab: () => Promise<BrowserTab>;
  // Runs an action the firewall approved and committed; the only path to it. The key goes to the
  // business's own system, so a retried call cannot act twice.
  execute: (action: ProposedAction, idempotencyKey: string) => Promise<R>;
  // Actions the business's systems can prepare first are checked twice: before they are prepared,
  // and against what was actually prepared.
  twoPhase?: TwoPhase<R>;
  // Origins the agent's browser may talk to, besides trustedOrigins. Everything else is refused,
  // so an injected agent cannot reach internal services or send data to its own server.
  allowedOrigins: string[];
  // Origins of the business's own systems. Everything else is untrusted.
  trustedOrigins?: string[];
}

// The firewall did not accept the session's intent. Nothing may run.
export class IntentRefused extends Error {
  constructor(readonly verdict: Verdict) {
    super(`the firewall answered ${verdict.decision} to this request`);
    this.name = "IntentRefused";
  }
}

const originOf = (url: string) => {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
};

const ruleIds = (v: Verdict) => [...new Set(v.reasons.map((r) => r.rule_id))];

export class Guard<R> {
  readonly #session: FirewallSession;
  readonly #options: GuardOptions<R>;
  readonly #trusted: Set<string>;
  readonly #allowed: Set<string>;
  readonly #read: string[] = [];
  #requested = 0;
  readonly events: GuardEvent[];
  readonly tools: GuardedTools<R>;

  private constructor(session: FirewallSession, options: GuardOptions<R>) {
    this.#session = session;
    this.#options = options;
    this.#trusted = new Set((options.trustedOrigins ?? []).map((o) => new URL(o).origin));
    this.#allowed = new Set([...this.#trusted, ...options.allowedOrigins.map((o) => new URL(o).origin)]);
    this.events = [{ checkpoint: "intent", verdict: session.intent }];
    this.tools = Object.freeze({
      browse: (url: string) => this.#browse(url),
      propose: (type: string, args: Record<string, unknown>) => this.#propose(type, args),
    });
  }

  // Throws IntentRefused unless the firewall answers ALLOW.
  static async start<R>(options: GuardOptions<R>): Promise<Guard<R>> {
    const session = await options.firewall.startSession({ prompt: options.prompt, mandate: options.mandate });
    if (session.intent.decision !== "ALLOW") throw new IntentRefused(session.intent);
    return new Guard(session, options);
  }

  get sessionId() {
    return this.#session.id;
  }

  // For the business to put in the agent's system prompt.
  get canary() {
    return this.#session.canary;
  }

  #nextId(): string {
    if (this.#requested >= MAX_READS) throw new FirewallError(`this session has reached its limit of ${MAX_READS} reads`);
    return `read-${++this.#requested}`;
  }

  #trustOf = (uri: string | null): ContextItem["trust"] => {
    if (!uri) return "untrusted";
    return this.#trusted.has(new URL(uri).origin) ? "trusted" : "untrusted";
  };

  // What the agent gets for an item is decided here, once, for every kind of read.
  async #inspect(item: ContextItem): Promise<ReadResult> {
    const verdict = await this.#session.inspectContext([item]);
    this.events.push({ checkpoint: "context", verdict, item_id: item.id });
    const uri = item.source.uri ?? null;
    // Released only on a clean ALLOW. A REVIEW can mean the firewall could not analyse the page
    // (CTX.RENDER_FAILED, CTX.STYLES_NOT_PROVIDED), and any purchase after it is held anyway, so
    // withholding costs nothing. An item the answer does not mention was not cleared.
    if (verdict.decision !== "ALLOW" || verdict.items.find((i) => i.id === item.id)?.quarantined !== false) {
      return { status: "withheld", id: item.id, uri, rule_ids: ruleIds(verdict) };
    }
    this.#read.push(item.id);
    return { status: "ok", id: item.id, uri, content: item.content };
  }

  #mayReach(url: string): boolean {
    const origin = originOf(url);
    return origin !== null && this.#allowed.has(origin);
  }

  // What the agent is about to send out of the session, in a URL or a tool's arguments.
  async #checkEgress(content: string): Promise<ReadResult | null> {
    const verdict = await this.#session.checkOutput(content);
    this.events.push({ checkpoint: "output", verdict });
    return verdict.decision === "ALLOW" ? null : { status: "refused", rule_ids: ruleIds(verdict) };
  }

  async #browse(url: string): Promise<ReadResult> {
    const { protocol, href } = new URL(url);
    if (protocol !== "http:" && protocol !== "https:") throw new FirewallError("only http(s) pages can be browsed");
    if (!this.#mayReach(href)) return { status: "refused", rule_ids: [ORIGIN_RULE] };
    // A URL is an output too. The allowlist is the real control; this catches a canary sent to
    // an allowed origin, for example in a search query.
    const refused = await this.#checkEgress(href);
    if (refused) return refused;
    const id = this.#nextId();
    const tab = await this.#options.openTab();
    try {
      // Every request the page makes is held to the allowlist, except that browsers do not ask
      // again when following a redirect. So a redirect off the list is caught as it happens and
      // nothing from that load reaches the agent, but the request itself has gone out. Stopping
      // that takes a network-level egress proxy around the agent's browser.
      let escaped = false;
      tab.on("request", (request) => {
        if (request.redirectedFrom() && !this.#mayReach(request.url())) escaped = true;
      });
      await tab.route("**/*", (route) => (this.#mayReach(route.request().url()) ? route.fallback() : route.abort()));
      const recorder = recordStylesheets(tab);
      const failed = await tab.goto(href).then(
        () => null,
        (err: unknown) => ({ err }),
      );
      if (escaped) return { status: "refused", rule_ids: [ORIGIN_RULE] };
      if (failed) throw failed.err;
      const item = await pageContextItem(tab, recorder, { id, trust: this.#trustOf });
      recorder.stop();
      if (escaped) return { status: "refused", rule_ids: [ORIGIN_RULE] };
      return await this.#inspect(item);
    } finally {
      await tab.close().catch(() => {});
    }
  }

  // Wraps another tool that brings content into the agent's context (a search, a document store,
  // a database). Its result goes through the same inspection as a page. `trust` is set here,
  // when the business wires the tool up, for tools that read its own systems.
  wrapRead<A extends unknown[]>(
    fn: (...args: A) => Promise<string>,
    opts: { kind?: "tool_result" | "document" | "email"; contentType?: ContextItem["content_type"]; trust?: ContextItem["trust"] } = {},
  ): (...args: A) => Promise<ReadResult> {
    return async (...args) => {
      const refused = await this.#checkEgress(JSON.stringify(args));
      if (refused) return refused;
      const id = this.#nextId();
      return this.#inspect({
        id,
        source: { kind: opts.kind ?? "tool_result" },
        trust: opts.trust ?? "untrusted",
        content_type: opts.contentType ?? "text/plain",
        content: await fn(...args),
      });
    };
  }

  // derived_from is everything the agent actually received. It is not asked: a compromised agent
  // would leave out the page that compromised it.
  async #propose(type: string, args: Record<string, unknown>): Promise<ProposalResult<R>> {
    const action: ProposedAction = structuredClone({ type, args, derived_from: [...this.#read] });
    const check = await this.#session.checkAction(action);
    this.events.push({ checkpoint: "action", verdict: check });
    if (!check.approval) return { status: check.decision === "BLOCK" ? "BLOCK" : "REVIEW", rule_ids: ruleIds(check) };

    const twoPhase = this.#options.twoPhase;
    if (twoPhase?.appliesTo(check.approval.action)) return this.#twoPhase(twoPhase, check.approval);

    const commit = await this.#session.commitAction(check.approval);
    this.events.push({ checkpoint: "commit", verdict: commit });
    if (commit.decision !== "ALLOW") return { status: commit.decision === "BLOCK" ? "BLOCK" : "REVIEW", rule_ids: ruleIds(commit) };

    return { status: "executed", receipt: await this.#options.execute(check.approval.action, check.approval.idempotencyKey) };
  }

  // Prepared only after the firewall approved the action, executed only after it checked what was
  // actually prepared. Anything but ALLOW at commit cancels, except REVIEW, which keeps it for a
  // person. Every failure cancels.
  async #twoPhase(twoPhase: TwoPhase<R>, approval: Approval): Promise<ProposalResult<R>> {
    const key = approval.idempotencyKey;
    let prepared: PreparedEffect;
    try {
      prepared = await twoPhase.prepare(approval.action, key);
    } catch (err) {
      await this.#session.releaseAction(approval).catch(() => undefined);
      throw err;
    }
    let commit;
    try {
      commit = await this.#session.commitAction(approval, approval.action, prepared);
    } catch (err) {
      // No answer from the firewall is not permission.
      await this.#cancelQuietly(twoPhase, prepared, key);
      throw err;
    }
    this.events.push({ checkpoint: "commit", verdict: commit });

    if (commit.decision === "ALLOW" && commit.next === "execute") {
      let done: Awaited<ReturnType<TwoPhase<R>["execute"]>>;
      try {
        done = await twoPhase.execute(prepared, approval.action, key);
      } catch (err) {
        await this.#cancelQuietly(twoPhase, prepared, key);
        throw err;
      }
      // It happened: the receipt is returned even if the firewall could not record it.
      await this.#session
        .reportOutcome(prepared, { outcome: "executed", status: done.status, ...(done.external_ids && { external_ids: done.external_ids }) })
        .catch(() => undefined);
      return { status: "executed", receipt: done.receipt };
    }
    if (commit.decision === "REVIEW") {
      await this.#session.reportOutcome(prepared, { outcome: "held", status: prepared.status ?? "held" }).catch(() => undefined);
      return { status: "REVIEW", rule_ids: ruleIds(commit), prepared };
    }
    // BLOCK, or an ALLOW without an execute instruction.
    await this.#cancelQuietly(twoPhase, prepared, key);
    return { status: "BLOCK", rule_ids: ruleIds(commit), prepared };
  }

  // Cancels and records it. A failed cancel leaves the prepared action to expire in its system,
  // which never executes it; the error is not the agent's to handle.
  async #cancelQuietly(twoPhase: TwoPhase<R>, prepared: PreparedEffect, key: string) {
    try {
      const c = await twoPhase.cancel(prepared, key);
      await this.#session.reportOutcome(prepared, { outcome: "cancelled", status: c.status }).catch(() => undefined);
    } catch {
      /* see above */
    }
  }

  // The agent's final message, or null if it must not be shown.
  async output(content: string): Promise<string | null> {
    const verdict = await this.#session.checkOutput(content);
    this.events.push({ checkpoint: "output", verdict });
    return verdict.decision === "ALLOW" ? content : null;
  }
}
