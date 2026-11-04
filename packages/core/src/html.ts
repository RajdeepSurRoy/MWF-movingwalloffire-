import { Parser } from "htmlparser2";

// "conditional": hidden by a class or stylesheet rule on an element with responsive classes
// (shown at some screen sizes). Its hard signals are downgraded to soft: REVIEW, never ALLOW.
export type Channel = "visible" | "hidden" | "conditional" | "comment" | "meta";

// Tailwind (`md:block`, `lg:hidden`) and Bootstrap (`d-md-block`) responsive display classes.
const RESPONSIVE_CLASS = /^(sm|md|lg|xl|2xl|max-\w+):|^d-(sm|md|lg|xl|xxl)-\w+$/;

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

// Class names that hide content in common CSS frameworks: the fallback for linked stylesheets
// the caller did not supply (which are held for review anyway, CTX.STYLES_NOT_PROVIDED).
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
  caseInsensitive: boolean;
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
// Strings ('…', "…") and backslash escapes are skipped, as a browser does, so a brace inside
// `content: "}"` cannot shift block boundaries. CSS a browser would also struggle with
// (unbalanced braces, an unclosed string or comment) is reported as malformed rather than
// guessed at: the caller then treats the page as unanalysable.
export function cssBlocks(css: string): { blocks: { selector: string; body: string }[]; malformed: boolean } {
  const blocks: { selector: string; body: string }[] = [];
  let start = 0; // where the current selector text begins
  let open = -1; // the "{" of the innermost block being read, or -1
  let depth = 0;
  let malformed = false;
  for (let i = 0; i < css.length; i++) {
    const ch = css.charCodeAt(i);
    if (ch === 92 /* \ */) {
      i++; // escaped character: never structural
      continue;
    }
    if (ch === 34 /* " */ || ch === 39 /* ' */) {
      let j = i + 1;
      while (j < css.length && css.charCodeAt(j) !== ch) {
        if (css.charCodeAt(j) === 92) j++;
        else if (css.charCodeAt(j) === 10) break; // strings cannot span lines
        j++;
      }
      if (j >= css.length || css.charCodeAt(j) !== ch) malformed = true;
      i = j;
      continue;
    }
    if (ch === 47 /* / */ && css.charCodeAt(i + 1) === 42 /* * */) {
      const end = css.indexOf("*/", i + 2);
      if (end < 0) malformed = true;
      i = end < 0 ? css.length : end + 1;
      continue;
    }
    if (ch === 123 /* { */) {
      // A "{" inside an open block means that block was an at-rule (@media ...): the
      // selector of the inner block starts right after it.
      if (open >= 0) start = open + 1;
      open = i;
      depth++;
    } else if (ch === 125 /* } */) {
      if (depth === 0) malformed = true;
      else depth--;
      if (open >= 0) blocks.push({ selector: css.slice(start, open), body: css.slice(open + 1, i) });
      open = -1;
      start = i + 1;
    } else if (ch === 59 /* ; */ && open < 0) {
      start = i + 1; // end of an @import / @charset statement
    }
  }
  if (depth !== 0) malformed = true;
  return { blocks, malformed };
}

const UNIVERSAL: Compound = { ids: [], classes: [], attrs: [], universal: true };

// Skips a quoted string starting at s[i]; returns the index after it, or -1 if unclosed.
function skipString(s: string, i: number): number {
  const q = s[i];
  for (let j = i + 1; j < s.length; j++) {
    if (s[j] === "\\") j++;
    else if (s[j] === q) return j + 1;
  }
  return -1;
}

// The rightmost compound selector: text after the last combinator at the top level,
// ignoring anything inside [...], (...), strings and escapes.
export function lastCompound(selector: string): string {
  let depth = 0;
  let start = 0;
  for (let i = 0; i < selector.length; i++) {
    const c = selector[i]!;
    if (c === "\\") i++;
    else if (c === '"' || c === "'") {
      const end = skipString(selector, i);
      if (end < 0) return selector.slice(start);
      i = end - 1;
    } else if (c === "[" || c === "(") depth++;
    else if (c === "]" || c === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0 && /[\s>+~]/.test(c)) start = i + 1;
  }
  return selector.slice(start).trim();
}

// Reads a CSS identifier at s[i], decoding escapes (`\31 `, `\:`) as a browser does.
function readIdent(s: string, i: number): { value: string; end: number } {
  let value = "";
  while (i < s.length) {
    const c = s[i]!;
    if (c === "\\") {
      const hex = /^[0-9a-f]{1,6}/i.exec(s.slice(i + 1, i + 7))?.[0];
      if (hex) {
        value += String.fromCodePoint(Math.min(Number.parseInt(hex, 16) || 0xfffd, 0x10ffff));
        i += 1 + hex.length;
        if (s[i] === " " || s[i] === "\t" || s[i] === "\n") i++;
      } else if (i + 1 < s.length) {
        value += s[i + 1];
        i += 2;
      } else break;
    } else if (/[\w-]/.test(c) || c.charCodeAt(0) >= 0x80) {
      value += c;
      i++;
    } else break;
  }
  return { value, end: i };
}

const ATTR_BODY = /^\s*([\w-]+)\s*(?:([~|^$*]?=)\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^\s"'\]]*)))?\s*([is])?\s*$/i;

// Parses one compound selector (e.g. `div.promo#x[data-a="b" i]:hover`). Pseudo-classes are
// ignored, which only widens the match. Returns null for a pseudo-element (it hides generated
// content, not element text) and UNIVERSAL for anything not understood with certainty, so
// unusual syntax makes more text get the strict hidden rules, never less.
export function parseCompound(s: string): Compound | null {
  const out: Compound = { ids: [], classes: [], attrs: [], universal: false };
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (c === "*") {
      i++;
    } else if (c === "#" || c === ".") {
      const id = readIdent(s, i + 1);
      if (!id.value) return UNIVERSAL;
      (c === "#" ? out.ids : out.classes).push(id.value.toLowerCase());
      i = id.end;
    } else if (c === "[") {
      let j = i + 1;
      while (j < s.length && s[j] !== "]") {
        if (s[j] === '"' || s[j] === "'") {
          const end = skipString(s, j);
          if (end < 0) return UNIVERSAL;
          j = end;
        } else j += s[j] === "\\" ? 2 : 1;
      }
      const m = ATTR_BODY.exec(s.slice(i + 1, j));
      if (j >= s.length || !m) return UNIVERSAL;
      const value = m[3] ?? m[4] ?? m[5] ?? "";
      if (value.includes("\\")) return UNIVERSAL;
      // Matched case-insensitively even without the `i` flag: only widens the match.
      out.attrs.push({ name: m[1]!.toLowerCase(), op: (m[2] ?? "") as AttrTest["op"], value, caseInsensitive: true });
      i = j + 1;
    } else if (c === ":") {
      if (s[i + 1] === ":") return null;
      const name = readIdent(s, i + 1);
      if (!name.value) return UNIVERSAL;
      i = name.end;
      if (s[i] === "(") {
        // Skip the argument, balanced and string-aware.
        let depth = 0;
        for (; i < s.length; i++) {
          if (s[i] === "\\") i++;
          else if (s[i] === '"' || s[i] === "'") {
            const end = skipString(s, i);
            if (end < 0) return UNIVERSAL;
            i = end - 1;
          } else if (s[i] === "(") depth++;
          else if (s[i] === ")" && --depth === 0) break;
        }
        if (depth !== 0) return UNIVERSAL;
        i++;
      }
    } else if (i === 0 && (/[a-z]/i.test(c) || c === "\\")) {
      const tag = readIdent(s, i);
      out.tag = tag.value.toLowerCase();
      i = tag.end;
    } else {
      return UNIVERSAL;
    }
  }
  out.universal = !out.tag && out.ids.length === 0 && out.classes.length === 0 && out.attrs.length === 0;
  return out;
}

// Selectors whose rules hide text, from <style> blocks. Only the rightmost compound of each
// selector is kept, so matching over-approximates what is hidden: more text gets the strict
// hidden-channel rules, never less. A selector that cannot be narrowed matches everything.
export function hidingSelectors(css: string): { rules: HidingRule[]; overflow: boolean } {
  const rules: HidingRule[] = [];
  if (css.length > MAX_CSS_CHARS) return { rules, overflow: true };
  const { blocks, malformed } = cssBlocks(css);
  for (const { selector, body } of blocks) {
    if (!hiddenByStyle(body)) continue;
    for (const raw of selector.split(",")) {
      const source = raw.trim();
      if (!source || source.startsWith("@")) continue;
      // null = pseudo-element (::before, ::-webkit-scrollbar): hides generated boxes, not text.
      const compound = parseCompound(lastCompound(source));
      if (!compound) continue;
      rules.push({ compound, source });
      if (rules.length > MAX_HIDING_SELECTORS) return { rules, overflow: true };
    }
  }
  return { rules, overflow: malformed };
}

function attrMatches(t: AttrTest, attrs: Record<string, string>): boolean {
  const raw = attrs[t.name];
  if (raw === undefined) return false;
  const v = t.caseInsensitive ? raw.toLowerCase() : raw;
  t = t.caseInsensitive ? { ...t, value: t.value.toLowerCase() } : t;
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
  // The page's CSS exceeded the analysis limits; visibility is unknown.
  styleOverflow: boolean;
}

// CSS escapes resolved (`@im\port`, `\40 import`), as the browser's tokenizer resolves them.
function decodeCssEscapes(css: string): string {
  return css.replace(/\\([0-9a-f]{1,6})[ \t\n\r\f]?|\\([^\n\r\f0-9a-f])/gi, (_m, hex: string | undefined, ch: string | undefined) => {
    if (ch !== undefined) return ch;
    const cp = Number.parseInt(hex!, 16);
    return cp > 0 && cp <= 0x10ffff && (cp < 0xd800 || cp > 0xdfff) ? String.fromCodePoint(cp) : "�";
  });
}
const COMMENT = String.raw`/\*[\s\S]*?\*/`;
const IMPORT = new RegExp(String.raw`@import(?:\s|${COMMENT})*(?:url\((?:\s|${COMMENT})*)?["']?([^"')\s;]+)`, "gi");

// What a stylesheet pulls in with @import. `unparsed` counts @import mentions no URL could be
// read from; the caller treats each as a stylesheet it was not given (fail closed).
export function cssImports(css: string): { urls: string[]; unparsed: number } {
  const text = decodeCssEscapes(css);
  const urls = [...text.matchAll(IMPORT)].map((m) => m[1]!);
  const mentions = text.match(/@import/gi)?.length ?? 0;
  return { urls, unparsed: Math.max(0, mentions - urls.length) };
}

export interface PageStyleRefs {
  // Text of the page's <style> blocks.
  css: string;
  // Stylesheets the page loads (<link rel="stylesheet">, @import in <style>), as written.
  stylesheets: string[];
  // The first <base href>, which relative links resolve against.
  baseHref: string | undefined;
  // @import mentions in <style> blocks no URL could be read from.
  unparsedImports: number;
}

// The page's own CSS and the stylesheets it links to.
export function pageStyleRefs(html: string): PageStyleRefs {
  let css = "";
  let inStyle = false;
  let baseHref: string | undefined;
  const stylesheets: string[] = [];
  const parser = new Parser(
    {
      ontext(text) {
        if (inStyle) css += text + "\n";
      },
      onopentag(name, attrs) {
        if (name === "style") inStyle = true;
        if (name === "base" && baseHref === undefined && attrs.href) baseHref = attrs.href;
        const rel = (attrs.rel ?? "").toLowerCase().split(/\s+/);
        // An "alternate stylesheet" is not applied unless the visitor picks it.
        if (name === "link" && rel.includes("stylesheet") && !rel.includes("alternate") && attrs.href) stylesheets.push(attrs.href);
      },
      onclosetag(name) {
        if (name === "style") inStyle = false;
      },
    },
    { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true },
  );
  parser.write(html);
  parser.end();
  const imports = cssImports(css);
  stylesheets.push(...imports.urls);
  return { css, stylesheets, baseHref, unparsedImports: imports.unparsed };
}

// Splits an HTML page into what a human sees and what only an agent reading the source sees.
// `extraCss`: the page's linked stylesheets, when the caller supplied them.
export function extractSegments(html: string, extraCss = ""): ExtractedPage {
  // First pass: collect <style> blocks, since a rule may come after the element it hides.
  const { css } = pageStyleRefs(html);
  const { rules, overflow } = hidingSelectors(extraCss ? `${css}\n${extraCss}` : css);
  const index = new SelectorIndex(rules);

  const segments: Segment[] = [];
  // `conditional`: hidden only through classes or stylesheet rules on an element that also has
  // responsive classes, i.e. probably visible to some visitors (Tailwind `hidden md:block`).
  const stack: { name: string; hidden: string; conditional: boolean; skip: boolean }[] = [];
  const top = () => stack[stack.length - 1];
  const seg = (el: { hidden: string; conditional: boolean } | undefined, text: string): Segment =>
    !el?.hidden
      ? { channel: "visible", text, how: "" }
      : { channel: el.conditional ? "conditional" : "hidden", text, how: el.hidden };

  const parser = new Parser(
    {
      onopentag(name, attrs) {
        const parent = top();
        const classes = (attrs.class ?? "").toLowerCase().split(/\s+/).filter(Boolean);
        const ids = attrs.id ? [attrs.id.toLowerCase()] : [];
        // Hiding that holds for every visitor: inherited for certain, inline, attribute, element.
        const certain =
          (parent?.hidden && !parent.conditional ? parent.hidden : "") ||
          hiddenByStyle(attrs.style) ||
          ("hidden" in attrs ? "hidden attribute" : "") ||
          (HIDDEN_ELEMENTS.has(name) ? `<${name}>` : "") ||
          (name === "input" && attrs.type?.toLowerCase() === "hidden" ? "hidden input" : "");
        let hidden = certain;
        let conditional = false;
        if (!hidden) {
          const viaSheet = index.find(name, ids, classes, attrs);
          const viaClass = classes.find((c) => HIDING_CLASSES.has(c));
          hidden =
            (viaSheet ? `stylesheet rule ${viaSheet.source}` : "") ||
            (viaClass ? `hiding class .${viaClass}` : "") ||
            (parent?.hidden ?? "");
          conditional = hidden !== "" && (classes.some((c) => RESPONSIVE_CLASS.test(c)) || (!viaSheet && !viaClass && !!parent?.conditional));
        }
        stack.push({ name, hidden, conditional, skip: (parent?.skip ?? false) || SKIP.has(name) });
        const el = top();
        if (name === "meta" && attrs.content) segments.push({ channel: "meta", text: attrs.content, how: "meta tag" });
        if (name === "input" && attrs.value && hidden) segments.push(seg(el, attrs.value));
        for (const a of VISIBLE_ATTRS) {
          const v = attrs[a];
          if (v) segments.push(seg(el, v));
        }
      },
      ontext(text) {
        const el = top();
        if (el?.skip || !text.trim()) return;
        segments.push(seg(el, text));
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
