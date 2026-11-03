import { Parser } from "htmlparser2";

export type Channel = "visible" | "hidden" | "comment" | "meta";

export interface Segment {
  channel: Channel;
  text: string;
  // Why a hidden segment is hidden, e.g. "display:none". Empty for other channels.
  how: string;
}

const SKIP = new Set(["script", "style"]);
// Content an agent reading the raw HTML sees but a human visitor does not.
const HIDDEN_ELEMENTS = new Set(["noscript", "template"]);
const VISIBLE_ATTRS = ["alt", "title", "aria-label"];

function parseStyle(style: string): Map<string, string> {
  const decls = new Map<string, string>();
  for (const decl of style.split(";")) {
    const i = decl.indexOf(":");
    if (i > 0) decls.set(decl.slice(0, i).trim().toLowerCase(), decl.slice(i + 1).trim().toLowerCase().replace(/\s*!important$/, ""));
  }
  return decls;
}

const normColor = (c: string) =>
  c
    .replace(/\s+/g, "")
    .replace(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/, "#$1$1$2$2$3$3")
    .replace(/^white$/, "#ffffff")
    .replace(/^rgb\(255,255,255\)$/, "#ffffff")
    .replace(/^black$/, "#000000")
    .replace(/^rgb\(0,0,0\)$/, "#000000");

// Returns why an element's inline style hides its text from a human, or "".
export function hiddenByStyle(style: string | undefined): string {
  if (!style) return "";
  const d = parseStyle(style);
  if (d.get("display") === "none") return "display:none";
  if (d.get("visibility") === "hidden") return "visibility:hidden";
  const opacity = d.get("opacity");
  if (opacity !== undefined && Number.parseFloat(opacity) <= 0.05) return "opacity:0";
  const size = d.get("font-size");
  if (size !== undefined && /^(0|0?\.\d+|1)(px|pt|em|rem)?$/.test(size)) return "tiny font-size";
  const color = d.get("color");
  if (color === "transparent") return "transparent text";
  const bg = d.get("background-color") ?? d.get("background");
  if (color && bg && normColor(color) === normColor(bg)) return "text color equals background";
  for (const side of ["left", "top", "right", "text-indent"]) {
    const v = d.get(side);
    if (v && /^-\d{3,}(px|em|rem)?$/.test(v) && Number.parseFloat(v) <= -500) return "positioned off-screen";
  }
  if (d.get("clip") === "rect(0,0,0,0)" || d.get("clip") === "rect(0 0 0 0)") return "clipped";
  return "";
}

// Class names that hide content in common CSS frameworks. External stylesheets are not
// fetched, so these are the only way to see hiding done there. A rendering-based check
// (headless browser, Phase 1) is what closes this gap fully.
const HIDING_CLASSES = new Set([
  "sr-only", "visually-hidden", "visuallyhidden", "screen-reader-text", "hidden", "d-none", "invisible",
  "hide", "is-hidden", "offscreen", "u-hidden", "a11y-hidden",
]);

// Limits on <style> content. Past them the page is not analysed further and is flagged instead,
// so padding a stylesheet can neither hide a rule nor slow the scanner down.
export const MAX_CSS_CHARS = 256_000;
export const MAX_HIDING_SELECTORS = 5_000;
export const MAX_MATCH_CHECKS = 2_000_000;

interface AttrTest {
  name: string;
  op: "" | "=" | "~=" | "|=" | "^=" | "$=" | "*=";
  value: string;
}

interface Compound {
  tag?: string;
  ids: string[];
  classes: string[];
  attrs: AttrTest[];
  // Nothing to match on (`*`, `:root`, `:not(...)` only): treated as matching every element.
  universal: boolean;
}

export interface HidingRule {
  compound: Compound;
  source: string;
}

// Linear-time split of CSS into (selector, declarations) pairs, innermost blocks only, so rules
// inside @media / @supports are seen. No backtracking regex runs over attacker-sized input.
export function cssBlocks(css: string): { selector: string; body: string }[] {
  const out: { selector: string; body: string }[] = [];
  let start = 0; // where the current selector text begins
  let open = -1; // the "{" of the block being read, or -1
  for (let i = 0; i < css.length; i++) {
    const ch = css.charCodeAt(i);
    if (ch === 47 /* / */ && css.charCodeAt(i + 1) === 42 /* * */) {
      const end = css.indexOf("*/", i + 2);
      i = end < 0 ? css.length : end + 1;
      continue;
    }
    if (ch === 123 /* { */) {
      // A "{" inside an open block means that block was an at-rule (@media ...): the
      // selector of the inner block starts right after it.
      if (open >= 0) start = open + 1;
      open = i;
    } else if (ch === 125 /* } */) {
      if (open >= 0) out.push({ selector: css.slice(start, open), body: css.slice(open + 1, i) });
      open = -1;
      start = i + 1;
    } else if (ch === 59 /* ; */ && open < 0) {
      start = i + 1; // end of an @import / @charset statement
    }
  }
  return out;
}

const ATTR = /\[\s*([\w-]+)\s*(?:([~|^$*]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]*)))?\s*[is]?\s*\]/g;

function parseCompound(last: string): Compound {
  const attrs: AttrTest[] = [...last.matchAll(ATTR)].map((m) => ({
    name: m[1]!.toLowerCase(),
    op: (m[2] ?? "") as AttrTest["op"],
    value: m[3] ?? m[4] ?? m[5] ?? "",
  }));
  // Pseudo-classes are dropped, which only widens the match (fail toward hidden).
  const bare = last.replace(ATTR, "").replace(/:[\w-]+(\([^)]*\))?/g, "");
  const tag = /^[a-z][a-z0-9-]*/i.exec(bare)?.[0]?.toLowerCase();
  const ids = [...bare.matchAll(/#([\w-]+)/g)].map((x) => x[1]!);
  const classes = [...bare.matchAll(/\.([\w-]+)/g)].map((x) => x[1]!.toLowerCase());
  const universal = !tag && ids.length === 0 && classes.length === 0 && attrs.length === 0;
  return { ...(tag ? { tag } : {}), ids, classes, attrs, universal };
}

// Selectors whose rules hide text, from <style> blocks. Only the rightmost compound of each
// selector is kept, so matching over-approximates what is hidden: more text gets the strict
// hidden-channel rules, never less. A selector that cannot be narrowed matches everything.
export function hidingSelectors(css: string): { rules: HidingRule[]; overflow: boolean } {
  const rules: HidingRule[] = [];
  if (css.length > MAX_CSS_CHARS) return { rules, overflow: true };
  for (const { selector, body } of cssBlocks(css)) {
    if (!hiddenByStyle(body)) continue;
    for (const raw of selector.split(",")) {
      const source = raw.trim();
      if (!source || source.startsWith("@")) continue;
      const last = source.split(/[\s>+~]+/).pop() ?? "";
      // Pseudo-elements (::before, ::-webkit-scrollbar) hide generated boxes, not element text.
      if (!last || last.includes("::")) continue;
      rules.push({ compound: parseCompound(last), source });
      if (rules.length > MAX_HIDING_SELECTORS) return { rules, overflow: true };
    }
  }
  return { rules, overflow: false };
}

function attrMatches(t: AttrTest, attrs: Record<string, string>): boolean {
  const v = attrs[t.name];
  if (v === undefined) return false;
  switch (t.op) {
    case "":
      return true;
    case "=":
      return v === t.value;
    case "~=":
      return v.split(/\s+/).includes(t.value);
    case "|=":
      return v === t.value || v.startsWith(`${t.value}-`);
    case "^=":
      return t.value !== "" && v.startsWith(t.value);
    case "$=":
      return t.value !== "" && v.endsWith(t.value);
    case "*=":
      return t.value !== "" && v.includes(t.value);
  }
}

function compoundMatches(c: Compound, name: string, ids: string[], classes: string[], attrs: Record<string, string>): boolean {
  return (
    (!c.tag || c.tag === "*" || c.tag === name) &&
    c.ids.every((i) => ids.includes(i)) &&
    c.classes.every((k) => classes.includes(k)) &&
    c.attrs.every((a) => attrMatches(a, attrs))
  );
}

// Rules indexed by one class, id or tag they require, so each element checks only its candidates.
class SelectorIndex {
  private byClass = new Map<string, HidingRule[]>();
  private byId = new Map<string, HidingRule[]>();
  private byTag = new Map<string, HidingRule[]>();
  private byAttr = new Map<string, HidingRule[]>();
  private universal: HidingRule | undefined;

  constructor(rules: HidingRule[]) {
    const add = (m: Map<string, HidingRule[]>, k: string, r: HidingRule) => {
      const list = m.get(k);
      if (list) list.push(r);
      else m.set(k, [r]);
    };
    for (const r of rules) {
      const c = r.compound;
      if (c.classes[0]) add(this.byClass, c.classes[0], r);
      else if (c.ids[0]) add(this.byId, c.ids[0], r);
      else if (c.tag && c.tag !== "*") add(this.byTag, c.tag, r);
      else if (c.attrs[0]) add(this.byAttr, c.attrs[0].name, r);
      else this.universal ??= r;
    }
  }

  // Hard cap on selector-match work per page; running out flags the page instead of stalling.
  checks = 0;
  get exhausted() {
    return this.checks > MAX_MATCH_CHECKS;
  }

  find(name: string, ids: string[], classes: string[], attrs: Record<string, string>): HidingRule | undefined {
    if (this.universal) return this.universal;
    const test = (list: HidingRule[] | undefined) =>
      list?.find((r) => ++this.checks <= MAX_MATCH_CHECKS && compoundMatches(r.compound, name, ids, classes, attrs));
    for (const k of classes) {
      const hit = test(this.byClass.get(k));
      if (hit) return hit;
    }
    for (const i of ids) {
      const hit = test(this.byId.get(i));
      if (hit) return hit;
    }
    const byTag = test(this.byTag.get(name));
    if (byTag) return byTag;
    for (const a of Object.keys(attrs)) {
      const hit = test(this.byAttr.get(a));
      if (hit) return hit;
    }
    return undefined;
  }
}

export interface ExtractedPage {
  segments: Segment[];
  // The page's <style> content exceeded the analysis limits; visibility is unknown.
  styleOverflow: boolean;
}

// Splits an HTML page into what a human sees and what only an agent reading the source sees.
export function extractSegments(html: string): ExtractedPage {
  // First pass: collect <style> blocks, since a rule may come after the element it hides.
  let css = "";
  let inStyle = false;
  const pre = new Parser(
    {
      ontext(text) {
        if (inStyle) css += text + "\n";
      },
      onopentag(name) {
        if (name === "style") inStyle = true;
      },
      onclosetag(name) {
        if (name === "style") inStyle = false;
      },
    },
    { decodeEntities: true, lowerCaseTags: true },
  );
  pre.write(html);
  pre.end();
  const { rules, overflow } = hidingSelectors(css);
  const index = new SelectorIndex(rules);

  const segments: Segment[] = [];
  const stack: { name: string; hidden: string; skip: boolean }[] = [];
  const top = () => stack[stack.length - 1];

  const parser = new Parser(
    {
      onopentag(name, attrs) {
        const parent = top();
        const classes = (attrs.class ?? "").toLowerCase().split(/\s+/).filter(Boolean);
        const ids = attrs.id ? [attrs.id] : [];
        const viaSheet = parent?.hidden ? undefined : index.find(name, ids, classes, attrs);
        const viaClass = classes.find((c) => HIDING_CLASSES.has(c));
        const hidden =
          parent?.hidden ||
          hiddenByStyle(attrs.style) ||
          ("hidden" in attrs ? "hidden attribute" : "") ||
          (HIDDEN_ELEMENTS.has(name) ? `<${name}>` : "") ||
          (viaSheet ? `stylesheet rule ${viaSheet.source}` : "") ||
          (viaClass ? `hiding class .${viaClass}` : "") ||
          (name === "input" && attrs.type?.toLowerCase() === "hidden" ? "hidden input" : "");
        stack.push({ name, hidden, skip: (parent?.skip ?? false) || SKIP.has(name) });
        if (name === "meta" && attrs.content) segments.push({ channel: "meta", text: attrs.content, how: "meta tag" });
        if (name === "input" && attrs.value && hidden) segments.push({ channel: "hidden", text: attrs.value, how: hidden });
        for (const a of VISIBLE_ATTRS) {
          const v = attrs[a];
          if (v) segments.push(hidden ? { channel: "hidden", text: v, how: hidden } : { channel: "visible", text: v, how: "" });
        }
      },
      ontext(text) {
        const el = top();
        if (el?.skip || !text.trim()) return;
        segments.push(el?.hidden ? { channel: "hidden", text, how: el.hidden } : { channel: "visible", text, how: "" });
      },
      oncomment(text) {
        if (text.trim()) segments.push({ channel: "comment", text, how: "HTML comment" });
      },
      onclosetag(name) {
        const i = stack.findLastIndex((e) => e.name === name);
        if (i >= 0) stack.length = i;
      },
    },
    { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true },
  );
  parser.write(html);
  parser.end();
  return { segments, styleOverflow: overflow || index.exhausted };
}
