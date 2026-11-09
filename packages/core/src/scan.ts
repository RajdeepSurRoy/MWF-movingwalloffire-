import { hashCanonical } from "./canonical.js";
import { type Channel, type Segment, cssImports, extractSegments, pageStyleRefs } from "./html.js";
import type { RenderReport, RenderReports } from "./rendered.js";
import { type RuleBundle, type Severity, regex } from "./rules.js";
import type { ContextItem } from "./schemas.js";

export interface Finding {
  rule_id: string;
  severity: Exclude<Severity, "none">;
  item_id: string;
  channel: Channel | "text";
  excerpt: string;
  /** Hash of everything that was detected (whole elements, all hidden texts), not just the excerpt.
   *  The session risk score counts each distinct fingerprint once. */
  fingerprint?: string;
}

const ZERO_WIDTH = /[​‌‍⁠﻿]/g;
const ZERO_WIDTH_IN_WORD = /\p{L}[​‌⁠﻿]+\p{L}/u;

// NFKC folds full-width and compatibility characters; spaces collapse but newlines stay,
// so `^` in a rule means "start of a text segment".
function normalize(text: string, stripZeroWidth: boolean): string {
  let t = text.normalize("NFKC");
  if (stripZeroWidth) t = t.replace(ZERO_WIDTH, "");
  return t.replace(/[^\S\n]+/g, " ").toLowerCase();
}

const excerptOf = (text: string, index: number) =>
  text.slice(Math.max(0, index - 10), index + 70).replace(/\s+/g, " ").trim();

// How strong a rule is in a channel: conditional (hidden at some screen sizes only) caps it at soft.
function severityIn(rule: RuleBundle["text_rules"][number], channel: Channel | "text") {
  if (channel === "visible" || channel === "text") return rule.visible;
  return channel === "conditional" && rule.hidden === "hard" ? "soft" : rule.hidden;
}

// The two views of a channel's text that rules run on. Lines: elements joined by newlines, so
// `^` anchors at each element. Flat: all whitespace folded to single spaces, so a phrase still
// matches when it is split across elements or across lines of one element.
const VIEWS = [
  { sep: "\n", fold: (t: string) => t },
  { sep: " ", fold: (t: string) => t.replace(/\s+/g, " ") },
];

interface Mark {
  signal: "hard" | "soft";
  rules: Set<string>;
}

// Runs the rules over a channel's texts. The one place rules run, so what is found and which
// texts it is marked on cannot disagree: each match marks every text it overlaps, so all parts
// of a split instruction are marked. `marks` is keyed by index into `texts`.
function matchChannel(bundle: RuleBundle, texts: string[], channel: Channel | "text", itemId: string): { findings: Finding[]; marks: Map<number, Mark> } {
  const findings = new Map<string, Finding>();
  const marks = new Map<number, Mark>();
  const units = texts
    .map((t, index) => ({ index, clean: normalize(t, true).trim(), raw: normalize(t, false).trim() }))
    .filter((u) => u.clean);
  for (const view of VIEWS) {
    const parts = units.map((u) => view.fold(u.clean));
    const joined = parts.join(view.sep);
    const unstripped = units.map((u) => view.fold(u.raw)).join(view.sep);
    const starts: number[] = [];
    let pos = 0;
    for (const part of parts) {
      starts.push(pos);
      pos += part.length + 1;
    }
    // The last unit starting at or before `at`.
    const unitAt = (at: number) => {
      let lo = 0;
      let hi = starts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (starts[mid]! <= at) lo = mid;
        else hi = mid - 1;
      }
      return lo;
    };
    const mark = (start: number, end: number, signal: "hard" | "soft", ruleId: string) => {
      for (let k = unitAt(start); k < parts.length && starts[k]! < end; k++) {
        if (start > starts[k]! + parts[k]!.length) continue; // the match begins on the separator after it
        const index = units[k]!.index;
        const m = marks.get(index);
        if (!m) marks.set(index, { signal, rules: new Set([ruleId]) });
        else {
          if (signal === "hard") m.signal = "hard";
          m.rules.add(ruleId);
        }
      }
    };
    // The whole texts every match overlaps: two findings with the same excerpt but different
    // content get different fingerprints.
    const matchedTexts = (matches: RegExpMatchArray[]) => {
      const seen = new Set<number>();
      for (const m of matches) {
        const end = m.index! + Math.max(m[0].length, 1);
        for (let k = unitAt(m.index!); k < parts.length && starts[k]! < end; k++) seen.add(k);
      }
      return [...seen].sort((a, b) => a - b).map((k) => parts[k]!);
    };
    const found = (rule_id: string, severity: Finding["severity"], matches: RegExpMatchArray[]) => {
      if (findings.has(rule_id)) return;
      const fingerprint = hashCanonical([rule_id, matchedTexts(matches)]);
      findings.set(rule_id, { rule_id, severity, item_id: itemId, channel, excerpt: excerptOf(joined, matches[0]!.index!), fingerprint });
    };
    for (const rule of bundle.text_rules) {
      const severity = severityIn(rule, channel);
      for (const p of rule.patterns) {
        const matches = [...joined.matchAll(regex(bundle, p, "gimu"))];
        if (!matches.length) continue;
        // Matches only once zero-width characters are removed: the text was disguised on purpose.
        const disguised = !regex(bundle, p, "imu").test(unstripped);
        if (disguised) found("CTX.OBFUSCATED_INSTRUCTION", "hard", matches);
        if (severity !== "none") found(rule.id, severity, matches);
        for (const m of matches) {
          const end = m.index + Math.max(m[0].length, 1);
          if (disguised) mark(m.index, end, "hard", "CTX.OBFUSCATED_INSTRUCTION");
          if (severity === "hard" || severity === "soft") mark(m.index, end, severity, rule.id);
        }
      }
    }
  }
  return { findings: [...findings.values()], marks };
}

// A whole segment that is just a standard UI label becomes empty; anything else is kept as is.
function stripExemptions(text: string, bundle: RuleBundle): string {
  const t = normalize(text, true);
  return bundle.hidden_exemptions.some((p) => regex(bundle, p, "iu").test(t)) ? "" : text;
}

// Base URL for pages without a usable source.uri; relative links then match no resource.
export const PAGE_BASE_FALLBACK = "https://page.invalid/";

// An absolute http(s) URL without its #fragment, or null (data:, javascript:, malformed).
export function resolveUrl(href: string, base: string): string | null {
  try {
    const u = new URL(href.trim(), base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    return u.href;
  } catch {
    return null;
  }
}

// The CSS a page loads, from the stylesheets the caller supplied, and the linked ones (also
// those @imported by supplied sheets) it did not supply. data: stylesheets carry their own CSS.
function pageStyles(item: ContextItem): { css: string; missing: string[] } {
  const supplied = new Map<string, { content: string; redirect?: string }>();
  for (const r of item.resources ?? []) {
    const url = resolveUrl(r.url, r.url);
    const redirect = r.redirect_to === undefined ? undefined : (resolveUrl(r.redirect_to, r.redirect_to) ?? undefined);
    if (url && !supplied.has(url)) supplied.set(url, { content: r.content, ...(redirect && { redirect }) });
  }
  const page = pageStyleRefs(item.content);
  const base = resolveUrl(page.baseHref ?? "", item.source.uri ?? PAGE_BASE_FALLBACK) ?? PAGE_BASE_FALLBACK;
  const css: string[] = [];
  const missing: string[] = [];
  const seen = new Set<string>();
  const unreadable = (where: string, n: number) => {
    if (n > 0) missing.push(`${n} @import rule(s) that could not be read, in ${where}`);
  };
  // A sheet's own @imports, resolved against the sheet (a data: sheet has none of its own URL).
  const follow = (content: string, from: string, where: string) => {
    css.push(content);
    const imports = cssImports(content);
    unreadable(where, imports.unparsed);
    for (const imp of imports.urls) visit(imp, from);
  };
  const visit = (href: string, from: string) => {
    if (/^\s*data:/i.test(href)) {
      if (seen.has(href)) return;
      seen.add(href);
      const inline = dataCss(href);
      if (inline === null) missing.push("data: stylesheet that could not be decoded");
      else follow(inline, from, "a data: stylesheet");
      return;
    }
    const url = resolveUrl(href, from);
    if (!url) return void missing.push(`stylesheet with an unusable URL: ${href.slice(0, 100)}`);
    if (seen.has(url)) return;
    seen.add(url);
    const sheet = supplied.get(url);
    if (sheet === undefined) return void missing.push(url);
    if (sheet.redirect) return visit(sheet.redirect, url); // `seen` stops redirect loops
    follow(sheet.content, url, url);
  };
  unreadable("the page's <style> blocks", page.unparsedImports);
  for (const href of page.stylesheets) visit(href, base);
  return { css: css.join("\n"), missing };
}

function dataCss(href: string): string | null {
  const m = /^\s*data:([^,]*),(.*)$/is.exec(href);
  if (!m) return null;
  try {
    return /;base64$/i.test(m[1]!) ? atob(m[2]!) : decodeURIComponent(m[2]!);
  } catch {
    return null;
  }
}

// Text the browser did not show, as extra segments. Static segments are kept as they are.
function renderedSegments(render: RenderReport & { ok: true }): Segment[] {
  return render.hidden.map((h) => ({ channel: h.certain ? "hidden" : "conditional", text: h.text, how: `rendered: ${h.how}` }));
}

// A piece of an item's text the provenance graph tracks: text a person does not see, or any
// text with a rule finding of its own. Visible text without findings is left out: product
// listings are untrusted too, and would link every purchase to "untrusted content".
export interface Span {
  index: number;
  channel: Channel | "text";
  how: string;
  text: string;
  // The strongest rule finding on this span alone; null when it is only hidden.
  signal: "hard" | "soft" | null;
  rule_ids: string[];
}

export interface ItemAnalysis {
  findings: Finding[];
  spans: Span[];
  // Every text of the item in page order, for the learned claim rules. Only filled when the
  // bundle has claim rules.
  texts?: string[];
}

// Most spans one item contributes to the graph; flagged spans are kept first.
export const MAX_SPANS_PER_ITEM = 500;

// Scans one context item for injection artifacts. Pure and deterministic.
// `render` is the headless-browser view of the page, when one was made (HTML items only).
export function scanContextItem(item: ContextItem, bundle: RuleBundle, render?: RenderReport): Finding[] {
  return analyzeContextItem(item, bundle, render).findings;
}

function spansFrom(segments: { channel: Channel | "text"; text: string; how: string }[], marks: Map<number, Mark>): Span[] {
  const spans: Span[] = [];
  segments.forEach((s, index) => {
    if (!s.text.trim()) return;
    const mark = marks.get(index);
    if (!mark && (s.channel === "visible" || s.channel === "text")) return;
    spans.push({ index, channel: s.channel, how: s.how, text: s.text, signal: mark?.signal ?? null, rule_ids: [...(mark?.rules ?? [])] });
  });
  const rank = (x: Span) => (x.signal === "hard" ? 0 : x.signal === "soft" ? 1 : 2);
  return spans.length <= MAX_SPANS_PER_ITEM ? spans : [...spans].sort((x, y) => rank(x) - rank(y) || x.index - y.index).slice(0, MAX_SPANS_PER_ITEM);
}

// `withTexts`: also return the item's texts (ItemAnalysis.texts).
export function analyzeContextItem(item: ContextItem, bundle: RuleBundle, render?: RenderReport, withTexts = bundle.claim_rules.length > 0): ItemAnalysis {
  if (item.trust === "trusted") return { findings: [], spans: [] };
  const findings: Finding[] = [];
  const push = (f: Finding) => {
    if (!findings.some((x) => x.rule_id === f.rule_id && x.channel === f.channel)) findings.push(f);
  };
  // For signals whose excerpt is fixed text: every different page counts.
  const pageFingerprint = hashCanonical([item.content, item.resources ?? null]);

  if (ZERO_WIDTH_IN_WORD.test(item.content)) {
    push({ rule_id: "CTX.ZERO_WIDTH", severity: "soft", item_id: item.id, channel: "text", excerpt: "zero-width characters inside words", fingerprint: pageFingerprint });
  }

  if (item.content_type !== "text/html") {
    const text = matchChannel(bundle, [item.content], "text", item.id);
    text.findings.forEach(push);
    return {
      findings,
      spans: spansFrom([{ channel: "text", text: item.content, how: "" }], text.marks),
      ...(withTexts && { texts: item.content.split(/\n+/).filter((t) => t.trim()) }),
    };
  }

  const styles = pageStyles(item);
  const { segments, styleOverflow } = extractSegments(item.content, styles.css);
  if (styleOverflow && !render?.ok) {
    // Too much CSS to analyse within limits: visibility is unknown, so do not let it pass clean.
    // A successful render applied all of it with the real cascade, so it covers this.
    push({ rule_id: "CTX.STYLE_UNANALYSABLE", severity: "soft", item_id: item.id, channel: "hidden", excerpt: "page CSS exceeds analysis limits", fingerprint: pageFingerprint });
  }
  // The browser's own list of stylesheets it was not given: catches any syntax the static
  // discovery above does not understand.
  for (const url of render?.ok ? (render.unstyled ?? []) : []) if (!styles.missing.includes(url)) styles.missing.push(url);
  if (styles.missing.length > 0) {
    // Hiding can live in CSS we were not given, so what a person sees is unknown.
    const more = styles.missing.length > 1 ? ` and ${styles.missing.length - 1} more` : "";
    push({ rule_id: "CTX.STYLES_NOT_PROVIDED", severity: "soft", item_id: item.id, channel: "hidden", excerpt: `${styles.missing[0]!.slice(0, 120)}${more}`, fingerprint: hashCanonical([...styles.missing].sort()) });
  }
  if (render?.ok === false) {
    push({ rule_id: "CTX.RENDER_FAILED", severity: "soft", item_id: item.id, channel: "hidden", excerpt: render.error.slice(0, 80), fingerprint: pageFingerprint });
  } else if (render) {
    segments.push(...renderedSegments(render));
  }
  // Standard UI labels ("Order history", "Add to cart") are removed from non-visible text
  // before matching, so hidden menus and hover buttons don't trip the broad purchase rule.
  const tracked = segments.map((s) => ({ ...s, text: s.channel === "visible" ? s.text : stripExemptions(s.text, bundle) }));
  const byChannel = new Map<Channel, number[]>();
  tracked.forEach((s, i) => {
    const list = byChannel.get(s.channel);
    if (list) list.push(i);
    else byChannel.set(s.channel, [i]);
  });

  const hidden = segments.filter((s) => s.channel === "hidden");
  if (hidden.length > 0) {
    // Hidden text alone is common on real sites (menus, screen-reader text): a weak signal.
    push({ rule_id: "CTX.HIDDEN_TEXT", severity: "info", item_id: item.id, channel: "hidden", excerpt: `${hidden[0]!.how}: ${hidden[0]!.text.trim().slice(0, 60)}`, fingerprint: hashCanonical(hidden.map((h) => [h.how, h.text.trim()])) });
  }
  const marks = new Map<number, Mark>();
  for (const [channel, idxs] of byChannel) {
    const result = matchChannel(bundle, idxs.map((i) => tracked[i]!.text), channel, item.id);
    result.findings.forEach(push);
    for (const [k, mark] of result.marks) marks.set(idxs[k]!, mark);
  }
  return {
    findings,
    spans: spansFrom(tracked, marks),
    ...(withTexts && { texts: blockTexts(tracked) }),
  };
}

// One text per block element and channel, in page order: what a reader takes as one piece of
// writing, however many inline tags or entities split it.
function blockTexts(segments: Segment[]): string[] {
  const out: string[] = [];
  let prev: Segment | undefined;
  for (const s of segments) {
    if (!s.text.trim()) continue;
    if (prev && prev.block !== undefined && prev.block === s.block && prev.channel === s.channel) out[out.length - 1] += ` ${s.text}`;
    else out.push(s.text);
    prev = s;
  }
  return out.map((t) => t.replace(/\s+/g, " ").trim());
}

export function scanContext(items: ContextItem[], bundle: RuleBundle, renders?: RenderReports): Finding[] {
  return items.flatMap((i) => scanContextItem(i, bundle, renders?.[hashCanonical(i)]));
}

export function analyzeContext(items: ContextItem[], bundle: RuleBundle, renders?: RenderReports, withTexts?: boolean): ItemAnalysis[] {
  return items.map((i) => analyzeContextItem(i, bundle, renders?.[hashCanonical(i)], withTexts));
}

// Scans free text (a user prompt, an agent output) as if a human could see all of it.
export function scanText(text: string, id: string, bundle: RuleBundle): Finding[] {
  return matchChannel(bundle, [text], "text", id).findings;
}
