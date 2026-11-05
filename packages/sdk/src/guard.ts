import type { ContextItem, Mandate, ProposedAction } from "@mwf/core";
import { type FirewallClient, FirewallError, type FirewallSession, type Verdict } from "./client.js";
import { type BrowserPage, pageContextItem, recordStylesheets } from "./page.js";

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

export interface BrowserTab extends BrowserPage {
  goto(url: string): Promise<unknown>;
  close(): Promise<void>;
}

export type ReadResult =
  | { status: "ok"; id: string; uri: string | null; content: string }
  | { status: "withheld"; id: string; uri: string | null; rule_ids: string[] }
  | { status: "refused"; rule_ids: string[] }; // the request itself was not sent

export type ProposalResult<R> = { status: "executed"; receipt: R } | { status: "BLOCK" | "REVIEW"; rule_ids: string[] };

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
  // payment provider, so a retried call cannot charge twice.
  execute: (action: ProposedAction, idempotencyKey: string) => Promise<R>;
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

const ruleIds = (v: Verdict) => [...new Set(v.reasons.map((r) => r.rule_id))];

export class Guard<R> {
  readonly #session: FirewallSession;
  readonly #options: GuardOptions<R>;
  readonly #trusted: Set<string>;
  readonly #read: string[] = [];
  #requested = 0;
  readonly events: GuardEvent[];
  readonly tools: GuardedTools<R>;

  private constructor(session: FirewallSession, options: GuardOptions<R>) {
    this.#session = session;
    this.#options = options;
    this.#trusted = new Set((options.trustedOrigins ?? []).map((o) => new URL(o).origin));
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
    // An item the answer does not mention was not cleared.
    if (verdict.items.find((i) => i.id === item.id)?.quarantined !== false) {
      return { status: "withheld", id: item.id, uri, rule_ids: ruleIds(verdict) };
    }
    this.#read.push(item.id);
    return { status: "ok", id: item.id, uri, content: item.content };
  }

  async #browse(url: string): Promise<ReadResult> {
    const { protocol, href } = new URL(url);
    if (protocol !== "http:" && protocol !== "https:") throw new FirewallError("only http(s) pages can be browsed");
    // A URL is an output too: a compromised agent can carry a secret out in one, to any server.
    const egress = await this.#session.checkOutput(href, href);
    this.events.push({ checkpoint: "output", verdict: egress });
    if (egress.decision !== "ALLOW") return { status: "refused", rule_ids: ruleIds(egress) };
    const id = this.#nextId();
    const tab = await this.#options.openTab();
    try {
      const recorder = recordStylesheets(tab);
      await tab.goto(href);
      const item = await pageContextItem(tab, recorder, { id, trust: this.#trustOf });
      recorder.stop();
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

    const commit = await this.#session.commitAction(check.approval);
    this.events.push({ checkpoint: "commit", verdict: commit });
    if (commit.decision !== "ALLOW") return { status: commit.decision === "BLOCK" ? "BLOCK" : "REVIEW", rule_ids: ruleIds(commit) };

    return { status: "executed", receipt: await this.#options.execute(check.approval.action, check.approval.idempotencyKey) };
  }

  // The agent's final message, or null if it must not be shown.
  async output(content: string): Promise<string | null> {
    const verdict = await this.#session.checkOutput(content);
    this.events.push({ checkpoint: "output", verdict });
    return verdict.decision === "ALLOW" ? content : null;
  }
}
