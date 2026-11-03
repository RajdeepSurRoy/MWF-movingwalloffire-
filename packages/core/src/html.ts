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

interface Compound {
  tag?: string;
  ids: string[];
  classes: string[];
}

// Simple compound selectors (tag, #id, .class) whose rules hide text, taken from <style> blocks.
// Only the rightmost compound of each selector is kept, so matching over-approximates what is
// hidden: more text gets the strict hidden-channel rules, never less.
export function hidingSelectors(css: string): { compound: Compound; source: string }[] {
  const out: { compound: Compound; source: string }[] = [];
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const m of clean.matchAll(/([^{};]+)\{([^{}]*)\}/g)) {
    if (!hiddenByStyle(m[2]!)) continue;
    for (const selector of m[1]!.split(",")) {
      const last = selector.trim().split(/[\s>+~]+/).pop() ?? "";
      if (!last || last.includes("::")) continue;
      const bare = last.replace(/\[[^\]]*\]|:[\w-]+(\([^)]*\))?/g, "");
      const tag = /^[a-z][a-z0-9-]*/i.exec(bare)?.[0]?.toLowerCase();
      const compound: Compound = {
        ...(tag && tag !== "*" ? { tag } : {}),
        ids: [...bare.matchAll(/#([\w-]+)/g)].map((x) => x[1]!),
        classes: [...bare.matchAll(/\.([\w-]+)/g)].map((x) => x[1]!.toLowerCase()),
      };
      if (compound.tag || compound.ids.length || compound.classes.length) out.push({ compound, source: selector.trim() });
    }
  }
  return out;
}

function matches(c: Compound, name: string, ids: string[], classes: string[]): boolean {
  return (!c.tag || c.tag === name) && c.ids.every((i) => ids.includes(i)) && c.classes.every((k) => classes.includes(k));
}

// Splits an HTML page into what a human sees and what only an agent reading the source sees.
export function extractSegments(html: string): Segment[] {
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
  const selectors = hidingSelectors(css);

  const segments: Segment[] = [];
  const stack: { name: string; hidden: string; skip: boolean }[] = [];
  const top = () => stack[stack.length - 1];

  const parser = new Parser(
    {
      onopentag(name, attrs) {
        const parent = top();
        const classes = (attrs.class ?? "").toLowerCase().split(/\s+/).filter(Boolean);
        const ids = attrs.id ? [attrs.id] : [];
        const viaSheet = selectors.find((s) => matches(s.compound, name, ids, classes));
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
  return segments;
}
