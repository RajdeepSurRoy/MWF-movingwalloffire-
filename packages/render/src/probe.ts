// Runs inside the headless page (serialised by page.evaluate), so it must be self-contained:
// no imports, no closures over module scope. The page's own scripts are disabled; this is the
// only code that runs there.

export interface ProbeHit {
  i: number; // text node index in document order, the same in every viewport
  text: string;
  how: string;
  certain: boolean;
}

export interface ProbeResult {
  hits: ProbeHit[];
  // More text nodes than the limit: the rest were not checked.
  truncated: boolean;
}

export function probe(maxTexts: number): ProbeResult {
  // Page markup can shadow DOM properties without any script: <img name="body"> makes
  // document.body that image, and <input name="parentElement"> inside a form changes the
  // form's parentElement. So every DOM read goes through the built-in prototypes instead.
  const getter = (proto: object, name: string) => Object.getOwnPropertyDescriptor(proto, name)!.get!;
  const bodyGet = getter(Document.prototype, "body");
  const rootGet = getter(Document.prototype, "documentElement");
  const parentGet = getter(Node.prototype, "parentElement");
  const parentOf = (e: Node): Element | null => parentGet.call(e) as Element | null;
  const rectOf = (e: Element): DOMRect => Element.prototype.getBoundingClientRect.call(e);
  const closest = (e: Element, sel: string): Element | null => Element.prototype.closest.call(e, sel);
  const matches = (e: Element, sel: string): boolean => Element.prototype.matches.call(e, sel);

  const hits: ProbeHit[] = [];
  const canvas = Document.prototype.createElement.call(document, "canvas") as HTMLCanvasElement;
  canvas.width = canvas.height = 1;
  const g = canvas.getContext("2d", { willReadFrequently: true });
  const colours = new Map<string, number[]>();

  // Any CSS colour syntax (rgb, oklch, color-mix...) to [r, g, b, a 0..1], via the canvas.
  const rgba = (c: string): number[] => {
    let v = colours.get(c);
    if (v) return v;
    if (!g) return [0, 0, 0, 1];
    g.clearRect(0, 0, 1, 1);
    g.fillStyle = "#000";
    g.fillStyle = c;
    g.fillRect(0, 0, 1, 1);
    const d = g.getImageData(0, 0, 1, 1).data;
    v = [d[0]!, d[1]!, d[2]!, d[3]! / 255];
    colours.set(c, v);
    return v;
  };
  const luminance = ([r, gr, b]: number[]) => {
    const f = (x: number) => ((x /= 255) <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(r!) + 0.7152 * f(gr!) + 0.0722 * f(b!);
  };
  const contrast = (a: number[], b: number[]) => {
    const [x, y] = [luminance(a), luminance(b)];
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  };

  // The colour painted behind an element, or null when it is an image or not opaque enough to know.
  const backgroundOf = (el: Element | null): number[] | null => {
    for (let e = el; e; e = parentOf(e)) {
      const cs = getComputedStyle(e);
      if (cs.backgroundImage !== "none") return null;
      const bg = rgba(cs.backgroundColor);
      if (bg[3]! >= 0.95) return bg;
      if (bg[3]! > 0.05) return null;
    }
    return [255, 255, 255, 1];
  };

  const opacityOf = (el: Element | null): number => {
    let o = 1;
    for (let e = el; e; e = parentOf(e)) {
      const cs = getComputedStyle(e);
      o *= Number.parseFloat(cs.opacity) || 0;
      const f = /opacity\(\s*([\d.]+)(%?)\s*\)/.exec(cs.filter);
      if (f) o *= Number.parseFloat(f[1]!) / (f[2] ? 100 : 1);
    }
    return o;
  };

  // Visible area of a rect after every clipping ancestor; also says whether a `clip`/`clip-path`
  // (never used for scrolling UIs) or an `overflow` container (carousels, accordions) did it.
  const clipped = (el: Element, r: DOMRect): { area: number; byClip: boolean } => {
    let [l, t, rt, b] = [r.left, r.top, r.right, r.bottom];
    let byClip = false;
    for (let e: Element | null = el; e && e !== root; e = parentOf(e)) {
      const cs = getComputedStyle(e);
      const clipsOverflow = cs.overflowX !== "visible" || cs.overflowY !== "visible";
      const m = /rect\(\s*(-?[\d.]+)px,?\s*(-?[\d.]+)px,?\s*(-?[\d.]+)px,?\s*(-?[\d.]+)px/.exec(cs.clip ?? "");
      // rect(top, right, bottom, left) with no area, or a clip-path that keeps nothing.
      const zeroClip =
        (m !== null && (Number(m[2]) - Number(m[4])) * (Number(m[3]) - Number(m[1])) <= 1) ||
        /inset\(\s*(4\d|50|100)%|circle\(\s*0|ellipse\(\s*0/.test(cs.clipPath);
      if (!clipsOverflow && !zeroClip) continue;
      const box = rectOf(e);
      [l, t, rt, b] = [Math.max(l, box.left), Math.max(t, box.top), Math.min(rt, box.right), Math.min(b, box.bottom)];
      if (zeroClip) {
        [rt, b] = [l, t];
        byClip = true;
      }
    }
    return { area: Math.max(0, rt - l) * Math.max(0, b - t), byClip };
  };

  // Painted invisibly whatever the layout: too small, faded out, transparent, or the colour of
  // its background. Computed styles exist even for content that is not laid out.
  const paintedInvisibly = (el: Element): string => {
    const cs = getComputedStyle(el);
    if (Number.parseFloat(cs.fontSize) < 4) return "font-size near zero";
    const opacity = opacityOf(el);
    if (opacity <= 0.05) return "opacity near zero";
    const fill = rgba(cs.webkitTextFillColor || cs.color);
    if (cs.textShadow !== "none" || Number.parseFloat(cs.webkitTextStrokeWidth) > 0) return "";
    if (fill[3]! * opacity <= 0.05) return "transparent text";
    const bg = backgroundOf(el);
    if (bg) {
      const a = fill[3]!;
      const painted = [0, 1, 2].map((k) => a * fill[k]! + (1 - a) * bg[k]!);
      if (contrast(painted, bg) < 1.1) return "text colour matches background";
    }
    return "";
  };

  const root = rootGet.call(document) as Element;
  const body = bodyGet.call(document) as Element | null;
  // Anything but a real <body> (a frameset, or none): walk the whole document.
  const start = body instanceof HTMLBodyElement ? body : root;
  const overflowX = [getComputedStyle(root).overflowX, getComputedStyle(start).overflowX];
  const noHorizontalScroll = overflowX.some((o) => o === "hidden" || o === "clip");
  const NOT_TEXT = "script, style";
  // A form field's own text, or content a visitor opens themselves (dropdown options, a closed
  // <details>): the text has no layout of its own, so the painted-invisibly checks apply to the
  // text and the layout checks to the field or <details> box.
  const FIELDS = "textarea, select, datalist";

  const walker = Document.prototype.createTreeWalker.call(document, start, NodeFilter.SHOW_TEXT);
  const range = Document.prototype.createRange.call(document);
  let i = -1;
  let truncated = false;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = n.nodeValue ?? "";
    if (!text.trim()) continue;
    if (++i >= maxTexts) {
      truncated = true;
      break;
    }
    const el = parentOf(n);
    if (!el || closest(el, NOT_TEXT)) continue;
    const hit = (how: string, certain: boolean) => hits.push({ i, text: text.slice(0, 4000), how, certain });
    const field = closest(el, FIELDS);
    const details = closest(el, "details:not([open])");
    const host = field ?? (details && !closest(el, "summary") ? details : null);
    if (host) {
      const how = paintedInvisibly(el);
      if (how) {
        hit(how, true);
        continue;
      }
      // Hidden by the page between the text and the control, where the browser's own hiding
      // (a closed dropdown or <details>) does not explain it.
      let hiddenBy = "";
      for (let e: Element | null = el; e && e !== host; e = parentOf(e)) {
        const s = getComputedStyle(e);
        if (s.display === "none") hiddenBy = "not rendered";
        else if (s.visibility !== "visible") hiddenBy ||= "visibility hidden";
      }
      if (matches(host, "datalist")) {
        // Only a datalist's options are ever offered to the visitor.
        if (!closest(el, "option")) hiddenBy ||= "not rendered";
      } else {
        const box = rectOf(host);
        const hs = getComputedStyle(host);
        if (box.width * box.height === 0) hiddenBy ||= "not rendered";
        else if (hs.visibility !== "visible") hiddenBy ||= "visibility hidden";
        else if (box.right + scrollX <= 0 || box.bottom + scrollY <= 0 || (noHorizontalScroll && box.left >= innerWidth)) {
          hit("positioned off the page", true);
          continue;
        } else {
          const c = clipped(host, box);
          if (c.area < 4) {
            hit(c.byClip ? "clipped away" : "clipped by a container", c.byClip);
            continue;
          }
        }
      }
      if (hiddenBy) hit(hiddenBy, false);
      continue;
    }
    const cs = getComputedStyle(el);
    const fontSize = Number.parseFloat(cs.fontSize);

    range.selectNodeContents(n);
    const rects = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
    if (rects.length === 0) {
      if (fontSize < 4) hit("font-size near zero", true);
      else hit("not rendered", false);
      continue;
    }
    if (cs.visibility !== "visible") {
      hit("visibility hidden", false);
      continue;
    }
    if (Math.max(...rects.map((r) => r.height)) < 3 || fontSize < 4) {
      hit("text too small to read", true);
      continue;
    }
    const opacity = opacityOf(el);
    if (opacity <= 0.05) {
      hit("opacity near zero", true);
      continue;
    }
    const fill = rgba(cs.webkitTextFillColor || cs.color);
    const outlined = cs.textShadow !== "none" || Number.parseFloat(cs.webkitTextStrokeWidth) > 0;
    if (fill[3]! * opacity <= 0.05 && !outlined) {
      hit("transparent text", true);
      continue;
    }
    const bg = backgroundOf(el);
    if (bg && !outlined) {
      const a = fill[3]!;
      const painted = [0, 1, 2].map((k) => a * fill[k]! + (1 - a) * bg[k]!);
      if (contrast(painted, bg) < 1.1) {
        hit("text colour matches background", true);
        continue;
      }
    }
    // Off the page: left of or above the document, or right of a page that cannot scroll sideways.
    const left = Math.min(...rects.map((r) => r.left)) + scrollX;
    const right = Math.max(...rects.map((r) => r.right)) + scrollX;
    const bottom = Math.max(...rects.map((r) => r.bottom)) + scrollY;
    if (right <= 0 || bottom <= 0 || (noHorizontalScroll && left >= innerWidth)) {
      hit("positioned off the page", true);
      continue;
    }
    const clips = rects.map((r) => clipped(el, r));
    if (clips.reduce((s, c) => s + c.area, 0) < 4) {
      const byClip = clips.some((c) => c.byClip);
      hit(byClip ? "clipped away" : "clipped by a container", byClip);
    }
  }
  return { hits, truncated };
}
