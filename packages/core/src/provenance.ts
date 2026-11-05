import { hashCanonical } from "./canonical.js";
import { normalizeEmail } from "./merchant.js";
import { toCents } from "./money.js";
import type { ItemAnalysis } from "./scan.js";
import { type ContextItem, type Mandate, PaymentArgs, type ProposedAction } from "./schemas.js";

// The session's provenance graph (architecture §6): where every value in an action came from.
//
// A path may start only at content that carries a signal: a span or source with a rule finding.
// Untrusted content as such is not a start: shop pages are untrusted, so every purchase has an
// untrusted source, and "untrusted → action" would hold every purchase for review.
//
// Two ways a signal reaches an action:
//   source ─derived_from─► action                   the agent says it relied on the page
//   span ─influenced─► value ─proposed─► action     an item, price or payee in the action
//                                                   appears in flagged text, whatever the
//                                                   agent says it relied on
// `contains` (source → span) is structure, not influence: paths never follow it.

export type NodeType = "intent" | "mandate" | "source" | "span" | "value" | "action";
export type EdgeType = "authorizes" | "contains" | "derived_from" | "influenced" | "proposed";
export type Signal = "hard" | "soft";

export interface GraphNode {
  id: string;
  type: NodeType;
  trust?: "trusted" | "untrusted";
  attrs: Record<string, unknown>;
}

export interface GraphEdge {
  src: string;
  dst: string;
  type: EdgeType;
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface TaintPath {
  nodes: string[];
  signal: Signal;
  via: "value" | "derived_from";
}

// Edges a path may follow.
export const PATH_EDGES: readonly EdgeType[] = ["derived_from", "influenced", "proposed"];
// Longest path the query follows (span → value → action is 2 edges).
export const MAX_PATH_EDGES = 4;

const EXCERPT = 300;

export const sourceId = (item: ContextItem) => `source:${item.id}@${hashCanonical(item).slice(0, 16)}`;
export const actionId = (action: ProposedAction) => `action:${hashCanonical(action).slice(0, 16)}`;

// ---------------------------------------------------------------------------
// Checkpoint 1: the user's intent authorizes the mandate.

export function intentGraph(prompt: string, mandate: Mandate): Graph {
  return {
    nodes: [
      { id: "intent", type: "intent", trust: "trusted", attrs: { text: prompt.slice(0, EXCERPT) } },
      { id: "mandate", type: "mandate", trust: "trusted", attrs: { hash: hashCanonical(mandate), category: mandate.category } },
    ],
    edges: [{ src: "intent", dst: "mandate", type: "authorizes" }],
  };
}

// ---------------------------------------------------------------------------
// Checkpoint 2: each item version is a source; its tracked spans hang off it.

const strongest = (signals: (string | null)[]): Signal | null =>
  signals.includes("hard") ? "hard" : signals.includes("soft") ? "soft" : null;

export function contextGraph(items: ContextItem[], analyses: ItemAnalysis[]): Graph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  items.forEach((item, k) => {
    const analysis = analyses[k] ?? { findings: [], spans: [] };
    const src = sourceId(item);
    nodes.push({
      id: src,
      type: "source",
      trust: item.trust,
      attrs: {
        item_id: item.id,
        kind: item.source.kind,
        ...(item.source.uri && { uri: item.source.uri }),
        signal: strongest(analysis.findings.map((f) => f.severity)),
        rule_ids: [...new Set(analysis.findings.filter((f) => f.severity !== "info").map((f) => f.rule_id))],
      },
    });
    for (const span of analysis.spans) {
      const id = `${src}#${span.index}`;
      nodes.push({
        id,
        type: "span",
        trust: item.trust,
        attrs: { item_id: item.id, channel: span.channel, how: span.how, text: span.text.trim().slice(0, EXCERPT), signal: span.signal, rule_ids: span.rule_ids },
      });
      edges.push({ src, dst: id, type: "contains" });
    }
  });
  return { nodes, edges };
}

// ---------------------------------------------------------------------------
// Checkpoint 3: the action, its values, and what influenced them.

const ZERO_WIDTH = /[​‌‍⁠﻿]/g;
const norm = (t: string) => t.normalize("NFKC").replace(ZERO_WIDTH, "").toLowerCase().replace(/\s+/g, " ");
const tokens = (t: string) => norm(t).match(/[\p{L}\p{N}]+/gu) ?? [];
const STOP = new Set(["the", "and", "for", "with", "pack", "set", "pcs", "per", "from"]);
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Money amounts written in text, in cents: "$500", "$19.49", "1,250.00 USD", "45 dollars".
function amountsIn(text: string): Set<number> {
  const out = new Set<number>();
  const t = norm(text);
  const toNum = (whole: string, frac = "") => Number(whole.replace(/,/g, "")) * 100 + Number(frac.padEnd(2, "0") || 0);
  for (const m of t.matchAll(/[$€£¥]\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?/g)) out.add(toNum(m[1]!, m[2]));
  for (const m of t.matchAll(/(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\s?(?:usd|eur|gbp|dollars?)\b/g)) out.add(toNum(m[1]!, m[2]));
  return out;
}

interface Value {
  id: string;
  kind: "item" | "amount" | "payee";
  label: string;
  matches: (text: string) => boolean;
}

// An item is named in text by its SKU as a whole token, or by most of its name's words.
function itemMatcher(sku: string, name: string): (text: string) => boolean {
  const skuRe = sku.length >= 3 ? new RegExp(`(^|[^\\p{L}\\p{N}])${escape(norm(sku))}($|[^\\p{L}\\p{N}])`, "u") : null;
  const words = [...new Set(tokens(name).filter((w) => w.length >= 3 && !STOP.has(w)))];
  const need = words.length === 1 ? (words[0]!.length >= 5 ? 1 : Infinity) : Math.max(2, Math.ceil((2 * words.length) / 3));
  return (text) => {
    if (skuRe?.test(norm(text))) return true;
    const have = new Set(tokens(text));
    return words.filter((w) => have.has(w)).length >= need;
  };
}

function actionValues(action: ProposedAction, act: string): Value[] {
  if (!action.type.startsWith("payment.")) return [];
  const parsed = PaymentArgs.safeParse(action.args);
  if (!parsed.success) return [];
  const { items, total, merchant } = parsed.data;
  const values: Value[] = items.map((item, i) => ({
    id: `${act}/item:${i}`,
    kind: "item",
    label: item.name,
    matches: itemMatcher(item.sku, item.name),
  }));
  const cents = new Set([toCents(total), ...items.map((i) => toCents(i.unit_price))]);
  for (const c of cents) {
    values.push({ id: `${act}/amount:${c}`, kind: "amount", label: (c / 100).toFixed(2), matches: (text) => amountsIn(text).has(c) });
  }
  if (merchant.payee_email) {
    const email = normalizeEmail(merchant.payee_email);
    values.push({ id: `${act}/payee`, kind: "payee", label: merchant.payee_email, matches: (text) => norm(text).includes(email) });
  }
  return values;
}

export function actionGraph({
  mandate,
  items,
  analyses,
  action,
}: {
  mandate: Mandate;
  items: ContextItem[];
  analyses: ItemAnalysis[];
  action: ProposedAction;
}): Graph {
  const { nodes, edges } = contextGraph(items, analyses);
  const act = actionId(action);
  nodes.push({ id: act, type: "action", attrs: { type: action.type, hash: hashCanonical(action), derived_from: action.derived_from } });
  if (mandate.allowed_actions.includes(action.type)) edges.push({ src: "mandate", dst: act, type: "authorizes" });
  const claimed = new Set(action.derived_from);
  items.forEach((item) => {
    if (claimed.has(item.id)) edges.push({ src: sourceId(item), dst: act, type: "derived_from" });
  });
  for (const v of actionValues(action, act)) {
    nodes.push({ id: v.id, type: "value", attrs: { kind: v.kind, label: v.label } });
    edges.push({ src: v.id, dst: act, type: "proposed" });
    // Only flagged spans can start a path, so only they are matched (which also bounds the
    // work on a session with many pages). Matching uses the full text; nodes keep an excerpt.
    items.forEach((item, k) => {
      for (const span of analyses[k]?.spans ?? []) {
        if (span.signal && v.matches(span.text)) edges.push({ src: `${sourceId(item)}#${span.index}`, dst: v.id, type: "influenced" });
      }
    });
  }
  return { nodes, edges };
}

// ---------------------------------------------------------------------------
// The path query: from every node carrying a signal to `target`, along PATH_EDGES, at most
// MAX_PATH_EDGES long. For each origin, its shortest path (ties: the smallest by node ids).
// The API runs the same query in SQL over the stored graph (selectPaths picks the same).

const pathKey = (nodes: string[]) => nodes.join("\u0000");

export function isOrigin(node: GraphNode): boolean {
  return (node.type === "source" || node.type === "span") && (node.attrs.signal === "hard" || node.attrs.signal === "soft");
}

// From candidate paths (origin first, target last), one per origin, in decision order:
// hard before soft, then value paths (they name what came from where) before declared ones,
// then shorter, then by node ids.
export function selectPaths(candidates: string[][], graph: Graph): TaintPath[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const best = new Map<string, string[]>();
  for (const nodes of candidates) {
    const cur = best.get(nodes[0]!);
    if (!cur || nodes.length < cur.length || (nodes.length === cur.length && pathKey(nodes) < pathKey(cur))) best.set(nodes[0]!, nodes);
  }
  const paths = [...best.values()].map((nodes): TaintPath => ({
    nodes,
    signal: byId.get(nodes[0]!)?.attrs.signal === "hard" ? "hard" : "soft",
    via: byId.get(nodes[1] ?? "")?.type === "value" ? "value" : "derived_from",
  }));
  const rank = (p: TaintPath) => (p.signal === "hard" ? 0 : 2) + (p.via === "value" ? 0 : 1);
  return paths.sort((a, b) => rank(a) - rank(b) || a.nodes.length - b.nodes.length || (pathKey(a.nodes) < pathKey(b.nodes) ? -1 : 1));
}

export function taintPaths(graph: Graph, target: string): TaintPath[] {
  const out = new Map<string, string[]>();
  for (const e of graph.edges) {
    if (!PATH_EDGES.includes(e.type)) continue;
    const list = out.get(e.src);
    if (list) list.push(e.dst);
    else out.set(e.src, [e.dst]);
  }
  const candidates: string[][] = [];
  const walk = (path: string[]) => {
    const last = path[path.length - 1]!;
    if (last === target) return void candidates.push(path);
    if (path.length > MAX_PATH_EDGES) return;
    for (const dst of out.get(last) ?? []) if (!path.includes(dst)) walk([...path, dst]);
  };
  for (const node of graph.nodes) if (isOrigin(node)) walk([node.id]);
  return selectPaths(candidates, graph);
}

// Merges graph fragments, keeping the first copy of each node and each edge.
export function mergeGraphs(...graphs: Graph[]): Graph {
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  for (const g of graphs) {
    for (const n of g.nodes) if (!nodes.has(n.id)) nodes.set(n.id, n);
    for (const e of g.edges) {
      const key = JSON.stringify([e.src, e.dst, e.type]);
      if (!edges.has(key)) edges.set(key, e);
    }
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}
