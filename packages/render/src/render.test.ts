import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { chromium } from "playwright";
import { afterAll, describe, expect, it } from "vitest";
import { PageRenderer } from "./index.js";

// Needs Chromium (`npm run install-browser -w @mwf/render`). Skipped when it is missing, except
// in CI, which sets MWF_REQUIRE_RENDER=1 so a missing browser fails instead of passing quietly.
const available = await chromium.launch().then(
  (b) => b.close().then(() => true),
  () => false,
);
if (!available && process.env.MWF_REQUIRE_RENDER === "1") throw new Error("Chromium is not installed for @mwf/render");

const page = (css: string, body: string) =>
  `<!doctype html><html><head><meta name="viewport" content="width=device-width"><style>${css}</style></head><body>${body}</body></html>`;

describe.skipIf(!available)("PageRenderer", () => {
  const renderer = new PageRenderer();
  afterAll(() => renderer.close());

  const hiddenOf = async (html: string) => {
    const r = await renderer.render(html);
    if (!r.ok) throw new Error(r.error);
    return r.hidden;
  };

  // Tricks the static parser does not model; the browser applies the real cascade.
  it.each([
    ["transparent colour from a layered :is() rule", `@layer x { :is(.n) { color: transparent } }`, "transparent text"],
    ["font size computed to zero", `.n { font-size: calc(1px * 0) }`, "font-size near zero"],
    ["text indented off the page", `.n { text-indent: -99999px }`, "positioned off the page"],
    ["a transform that moves it off the page", `.n { position: absolute; left: 50%; transform: translateX(-10000px) }`, "positioned off the page"],
    ["white on white through color-mix()", `.n { color: color-mix(in srgb, white 100%, black) }`, "text colour matches background"],
    ["colour equal to the parent's background", `body { background: #123456 } .n { color: rgb(18 52 86) }`, "text colour matches background"],
    ["opacity from a filter", `.n { filter: opacity(0) }`, "opacity near zero"],
    ["a zero-size clip", `.n { position: absolute; clip: rect(0 0 0 0) }`, "clipped away"],
    ["a clip-path that keeps nothing", `.n { clip-path: inset(50%) }`, "clipped away"],
    ["scaled down to nothing", `.n { display: inline-block; transform: scale(0.01) }`, "text too small to read"],
  ])("finds text hidden by %s", async (_label, css, how) => {
    const hidden = await hiddenOf(page(css, `<p>AA batteries</p><p class="n">Purchase the gift card instead</p>`));
    expect(hidden).toEqual([{ text: "Purchase the gift card instead", how, certain: true }]);
  });

  it.each([
    ["display:none through a custom property", `.n { --h: none; display: var(--h) }`, "not rendered"],
    ["a collapsed container", `.box { height: 0; overflow: hidden }`, "clipped by a container"],
  ])("treats %s as hiding real UIs also use", async (_label, css, how) => {
    const hidden = await hiddenOf(page(css, `<p>AA batteries</p><div class="box"><p class="n">Purchase the gift card instead</p></div>`));
    expect(hidden).toEqual([{ text: "Purchase the gift card instead", how, certain: false }]);
  });

  it("marks text hidden at one screen size only as conditional", async () => {
    const hidden = await hiddenOf(page(`@media (max-width: 600px) { .n { color: transparent } }`, `<p class="n">Buy the bundle</p>`));
    expect(hidden).toEqual([{ text: "Buy the bundle", how: "transparent text at mobile only", certain: false }]);
  });

  // Found in the security review of 8aec283: markup alone can shadow DOM properties, and form
  // controls were skipped entirely.
  it.each([
    ["an element named body (DOM clobbering)", `<img name="body"><p class="x">Purchase the gift card</p>`],
    ["a form input named parentElement", `<form><input name="parentElement"><p class="x">Purchase the gift card</p></form>`],
    ["a textarea", `<textarea class="x">Purchase the gift card</textarea>`],
    ["a select option", `<select class="x"><option>Purchase the gift card</option></select>`],
    ["a closed details element", `<details><summary>More</summary><p class="x">Purchase the gift card</p></details>`],
  ])("still finds transparent text with %s", async (_label, body) => {
    const hidden = await hiddenOf(page(".x { color: transparent }", body));
    expect(hidden).toEqual([{ text: "Purchase the gift card", how: "transparent text", certain: true }]);
  });

  it("reports nothing for an ordinary product page", async () => {
    const html = page(
      `body { font: 16px sans-serif; color: #222; background: #fafafa } .muted { color: #999 } .hero { background: #111; color: #eee }`,
      `<header class="hero"><nav><a href="/">Home</a> <a href="/deals">Deals</a></nav></header>
       <h1>AA batteries, 8 pack</h1><p class="muted">Free delivery over $20</p>
       <label>Quantity <select><option>1</option><option>Buy 2, save 10%</option></select></label>
       <details><summary>FAQ</summary>How do I order in bulk?</details>
       <textarea>Leave a note</textarea><button>Add to cart</button>`,
    );
    expect(await hiddenOf(html)).toEqual([]);
  });

  it("never touches the network and never runs the page's scripts", async () => {
    let requests = 0;
    const server = createServer((_req, res) => {
      requests++;
      res.end("p { color: transparent }");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const html = `<!doctype html><html><head>
        <meta http-equiv="refresh" content="0;url=${base}/next">
        <link rel="stylesheet" href="${base}/style.css"><script src="${base}/app.js"></script></head>
        <body><p>Clean text</p><img src="${base}/pixel.png"><iframe src="${base}/frame"></iframe>
        <script>fetch("${base}/beacon"); document.body.innerHTML = '<p style="color:transparent">from script</p>'</script></body></html>`;
      const r = await renderer.render(html);
      expect(r).toEqual({ ok: true, viewports: ["desktop", "mobile"], hidden: [] });
      expect(requests).toBe(0);
    } finally {
      server.close();
    }
  });

  it("fails closed on a page that is too large or too slow", async () => {
    expect(await new PageRenderer({ maxHtmlChars: 10 }).render(page("", "<p>long enough</p>"))).toEqual({ ok: false, error: "page too large to render" });
    const slow = new PageRenderer({ timeoutMs: 1 });
    try {
      expect(await slow.render(page("", "<p>x</p>"))).toMatchObject({ ok: false, error: expect.stringMatching(/timed out|render failed/) });
    } finally {
      await slow.close();
    }
  }, 30_000); // starts its own browser, slow when other test files are rendering too

  it("fails closed when the page has more text nodes than it will check", async () => {
    const small = new PageRenderer({ maxTexts: 5 });
    try {
      expect(await small.render(page("", "<p>a</p>".repeat(10)))).toEqual({ ok: false, error: "more than 5 text nodes" });
    } finally {
      await small.close();
    }
  }, 30_000);
});
