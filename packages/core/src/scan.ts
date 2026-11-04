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

function matchRules(bundle: RuleBundle, raw: string, channel: Channel | "text", itemId: string): Finding[] {
  const findings: Finding[] = [];
  const clean = normalize(raw, true);
  const unstripped = normalize(raw, false);
  for (const rule of bundle.text_rules) {
    const severity =
      channel === "visible" || channel === "text"
        ? rule.visible
        : channel === "conditional" && rule.hidden === "hard"
          ? "soft"
          : rule.hidden;
    for (const p of rule.patterns) {
      const re = regex(bundle, p, "imu");
      const m = re.exec(clean);
      if (!m) continue;
      // Matches only once zero-width characters are removed: the text was disguised on purpose.
      if (!re.test(unstripped)) {
        findings.push({ rule_id: "CTX.OBFUSCATED_INSTRUCTION", severity: "hard", item_id: itemId, channel, excerpt: excerptOf(clean, m.index) });
      }
      if (severity !== "none") findings.push({ rule_id: rule.id, severity, item_id: itemId, channel, excerpt: excerptOf(clean, m.index) });
      break;
    }
  }
  return findings;
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

// A stylesheet's @import targets made absolute against `base`, for serving it from another URL
// (a redirect's source). Forms this does not rewrite still resolve against the wrong URL,
// which the renderer then reports as a stylesheet it was not given: it fails closed.
export function rebaseImports(css: string, base: string): string {
  return css.replace(/(@import\s+(?:url\(\s*)?["']?)([^"')\s;]+)/gi, (_m, pre: string, href: string) => pre + (resolveUrl(href, base) ?? href));
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

// Scans one context item for injection artifacts. Pure and deterministic.
// `render` is the headless-browser view of the page, when one was made (HTML items only).
export function scanContextItem(item: ContextItem, bundle: RuleBundle, render?: RenderReport): Finding[] {
  if (item.trust === "trusted") return [];
  const findings: Finding[] = [];
  const push = (f: Finding) => {
    if (!findings.some((x) => x.rule_id === f.rule_id && x.channel === f.channel)) findings.push(f);
  };

  if (ZERO_WIDTH_IN_WORD.test(item.content)) {
    push({ rule_id: "CTX.ZERO_WIDTH", severity: "soft", item_id: item.id, channel: "text", excerpt: "zero-width characters inside words" });
  }

  if (item.content_type !== "text/html") {
    for (const f of matchRules(bundle, item.content, "text", item.id)) push(f);
    return findings;
  }

  const styles = pageStyles(item);
  const { segments, styleOverflow } = extractSegments(item.content, styles.css);
  if (styleOverflow && !render?.ok) {
    // Too much CSS to analyse within limits: visibility is unknown, so do not let it pass clean.
    // A successful render applied all of it with the real cascade, so it covers this.
    push({ rule_id: "CTX.STYLE_UNANALYSABLE", severity: "soft", item_id: item.id, channel: "hidden", excerpt: "page CSS exceeds analysis limits" });
  }
  // The browser's own list of stylesheets it was not given: catches any syntax the static
  // discovery above does not understand.
  for (const url of render?.ok ? (render.unstyled ?? []) : []) if (!styles.missing.includes(url)) styles.missing.push(url);
  if (styles.missing.length > 0) {
    // Hiding can live in CSS we were not given, so what a person sees is unknown.
    const more = styles.missing.length > 1 ? ` and ${styles.missing.length - 1} more` : "";
    push({ rule_id: "CTX.STYLES_NOT_PROVIDED", severity: "soft", item_id: item.id, channel: "hidden", excerpt: `${styles.missing[0]!.slice(0, 120)}${more}` });
  }
  if (render?.ok === false) {
    push({ rule_id: "CTX.RENDER_FAILED", severity: "soft", item_id: item.id, channel: "hidden", excerpt: render.error.slice(0, 80) });
  } else if (render) {
    segments.push(...renderedSegments(render));
  }
  const byChannel = new Map<Channel, string[]>();
  for (const s of segments) {
    // Standard UI labels ("Order history", "Add to cart") are removed from non-visible text
    // before matching, so hidden menus and hover buttons don't trip the broad purchase rule.
    const text = s.channel === "visible" ? s.text : stripExemptions(s.text, bundle);
    const list = byChannel.get(s.channel);
    if (list) list.push(text);
    else byChannel.set(s.channel, [text]);
  }

  const hidden = segments.filter((s) => s.channel === "hidden");
  if (hidden.length > 0) {
    // Hidden text alone is common on real sites (menus, screen-reader text): a weak signal.
    push({ rule_id: "CTX.HIDDEN_TEXT", severity: "info", item_id: item.id, channel: "hidden", excerpt: `${hidden[0]!.how}: ${hidden[0]!.text.trim().slice(0, 60)}` });
  }
  for (const [channel, texts] of byChannel) {
    for (const f of matchRules(bundle, texts.join("\n"), channel, item.id)) push(f);
  }
  return findings;
}

export function scanContext(items: ContextItem[], bundle: RuleBundle, renders?: RenderReports): Finding[] {
  return items.flatMap((i) => scanContextItem(i, bundle, renders?.[hashCanonical(i)]));
}

// Scans free text (a user prompt, an agent output) as if a human could see all of it.
export function scanText(text: string, id: string, bundle: RuleBundle): Finding[] {
  return matchRules(bundle, text, "text", id);
}
