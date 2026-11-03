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

// Splits an HTML page into what a human sees and what only an agent reading the source sees.
export function extractSegments(html: string): Segment[] {
  const segments: Segment[] = [];
  const stack: { name: string; hidden: string; skip: boolean }[] = [];
  const top = () => stack[stack.length - 1];

  const parser = new Parser(
    {
      onopentag(name, attrs) {
        const parent = top();
        const hidden =
          parent?.hidden ||
          hiddenByStyle(attrs.style) ||
          ("hidden" in attrs ? "hidden attribute" : "") ||
          (HIDDEN_ELEMENTS.has(name) ? `<${name}>` : "");
        stack.push({ name, hidden, skip: (parent?.skip ?? false) || SKIP.has(name) });
        if (name === "meta" && attrs.content) segments.push({ channel: "meta", text: attrs.content, how: "meta tag" });
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
