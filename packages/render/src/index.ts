import { type ContextItem, PAGE_BASE_FALLBACK, type RenderReport, type RenderedText, resolveUrl } from "@mwf/core";
import { type Browser, type BrowserContext, chromium } from "playwright";
import { type ProbeResult, probe } from "./probe.js";

// Renders untrusted HTML in headless Chromium to find text a person would not see.
// The page is sandboxed: its scripts are disabled and every network request is refused, so a
// page cannot phone home, load more content, or behave differently for the firewall.
// Stylesheets the page links to are applied only from what the caller supplied.

// Sent as source text. tsx/esbuild may wrap named functions in a `__name` helper that does not
// exist in the page, so a no-op one is defined around the probe.
const PROBE_SOURCE = (maxTexts: number) => `(() => { const __name = (f) => f; return (${probe.toString()})(${maxTexts}); })()`;

// The page's address and the stylesheets the agent's browser loaded for it.
export interface PageInput {
  url?: string | undefined;
  stylesheets?: { url: string; content: string }[] | undefined;
}

export interface Viewport {
  name: string;
  width: number;
  height: number;
  mobile: boolean;
}

export const VIEWPORTS: Viewport[] = [
  { name: "desktop", width: 1280, height: 800, mobile: false },
  { name: "mobile", width: 390, height: 844, mobile: true },
];

export interface RendererOptions {
  timeoutMs?: number;
  // The page and its stylesheets together.
  maxHtmlChars?: number;
  maxTexts?: number;
  // Pages rendered at once; more wait their turn.
  concurrency?: number;
  viewports?: Viewport[];
  // Chromium's OS sandbox, so a browser exploit in a hostile page stays contained. Turn off
  // only where the host cannot provide it (some containers); see docs/manual-tasks.md.
  sandbox?: boolean;
}

// One render's browser contexts. Once it is finished, a context created late (after a
// timeout) is closed at once instead of running on outside the concurrency limit.
interface Run {
  done: boolean;
  contexts: BrowserContext[];
  // Stylesheet requests that had nothing supplied to answer them.
  unstyled: Set<string>;
}

export class PageRenderer {
  readonly #opts: Required<RendererOptions>;
  #browser: Promise<Browser> | undefined;
  #running = 0;
  readonly #queue: (() => void)[] = [];

  constructor(opts: RendererOptions = {}) {
    this.#opts = {
      timeoutMs: opts.timeoutMs ?? 8000,
      maxHtmlChars: opts.maxHtmlChars ?? 4_000_000,
      maxTexts: opts.maxTexts ?? 20_000,
      concurrency: opts.concurrency ?? 4,
      viewports: opts.viewports ?? VIEWPORTS,
      sandbox: opts.sandbox ?? true,
    };
  }

  // Never throws: any failure is a report with ok: false, which the scanner turns into a REVIEW.
  async render(html: string, page: PageInput = {}): Promise<RenderReport> {
    const size = html.length + (page.stylesheets ?? []).reduce((n, s) => n + s.content.length, 0);
    if (size > this.#opts.maxHtmlChars) return { ok: false, error: "page too large to render" };
    await this.#acquire();
    const run: Run = { done: false, contexts: [], unstyled: new Set() };
    let timer: NodeJS.Timeout | undefined;
    let work: Promise<unknown> = Promise.resolve();
    try {
      // The deadline covers starting the browser too, so a stuck launch cannot stall the API.
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${this.#opts.timeoutMs} ms`)), this.#opts.timeoutMs);
      });
      timeout.catch(() => {});
      const browser = await Promise.race([this.#launch(), timeout]);
      const views = Promise.all(this.#opts.viewports.map((v) => this.#probe(browser, run, html, page, v)));
      work = views.catch(() => {}); // after a timeout the closed contexts make it reject
      const done = await Promise.race([views, timeout]);
      if (done.some((v) => v.truncated)) return { ok: false, error: `more than ${this.#opts.maxTexts} text nodes` };
      return {
        ok: true,
        viewports: this.#opts.viewports.map((v) => v.name),
        hidden: merge(done, this.#opts.viewports),
        unstyled: [...run.unstyled],
      };
    } catch (err) {
      return { ok: false, error: `render failed: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}` };
    } finally {
      clearTimeout(timer);
      run.done = true;
      await Promise.allSettled(run.contexts.map((c) => c.close()));
      // Hold the slot until the abandoned work has wound down (bounded, in case the browser hangs).
      await Promise.race([work, new Promise((resolve) => setTimeout(resolve, 2000).unref())]);
      this.#release();
    }
  }

  // A context item as sent to /v1/context/inspect: its page, address and supplied stylesheets.
  renderItem(item: ContextItem): Promise<RenderReport> {
    return this.render(item.content, { url: item.source.uri, stylesheets: item.resources });
  }

  async close(): Promise<void> {
    const browser = this.#browser;
    this.#browser = undefined;
    if (browser) await (await browser.catch(() => undefined))?.close();
  }

  async #launch(): Promise<Browser> {
    const current = this.#browser && (await this.#browser.catch(() => undefined));
    if (current?.isConnected()) return current;
    this.#browser = chromium.launch({
      headless: true,
      timeout: 20_000, // a launch that fails is retried by the next render
      chromiumSandbox: this.#opts.sandbox,
      // Request interception only sees requests. DNS prefetch and preconnect (<link
      // rel="preconnect">) work below it, so also: no name resolves, prefetch is off, and any
      // connection that still happens (an IP literal, loopback included) goes to a dead proxy port.
      proxy: { server: "http://127.0.0.1:9", bypass: "<-loopback>" },
      args: ["--host-resolver-rules=MAP * ~NOTFOUND", "--dns-prefetch-disable", "--disable-features=NetworkPrediction"],
    });
    return this.#browser;
  }

  async #probe(browser: Browser, run: Run, html: string, input: PageInput, v: Viewport): Promise<ProbeResult> {
    const context = await browser.newContext({
      javaScriptEnabled: false,
      offline: true, // route.fulfill still answers; nothing else gets out
      serviceWorkers: "block",
      acceptDownloads: false,
      viewport: { width: v.width, height: v.height },
      isMobile: v.mobile,
      hasTouch: v.mobile,
    });
    if (run.done) {
      await context.close();
      throw new Error("render already finished");
    }
    run.contexts.push(context);
    // Every request is answered here; nothing reaches the network. The page is served at its
    // own URL so relative links resolve as they did for the agent, and each stylesheet comes
    // from what the caller supplied.
    const pageUrl = resolveUrl(input.url ?? "", PAGE_BASE_FALLBACK) ?? PAGE_BASE_FALLBACK;
    const styles = new Map<string, string>();
    for (const s of input.stylesheets ?? []) {
      const url = resolveUrl(s.url, s.url);
      if (url && !styles.has(url)) styles.set(url, s.content);
    }
    let served = false;
    await context.route("**/*", (route) => {
      const req = route.request();
      if (req.isNavigationRequest()) {
        if (!served) {
          served = true;
          return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html });
        }
        // Meta refresh, iframes: "No Content" keeps the browser where it is. Refusing the
        // request instead would load Chromium's error page over the one being checked.
        return route.fulfill({ status: 204 });
      }
      if (req.resourceType() === "stylesheet") {
        const url = resolveUrl(req.url(), req.url());
        const css = url ? styles.get(url) : undefined;
        if (css !== undefined) return route.fulfill({ status: 200, contentType: "text/css; charset=utf-8", body: css });
        // The browser's own parser found a stylesheet we were not given: whatever syntax
        // hid it from the static scan, it is reported, not silently skipped.
        run.unstyled.add(url ?? req.url().slice(0, 2000));
      }
      return route.abort("blockedbyclient");
    });
    const page = await context.newPage();
    await page.goto(pageUrl, { waitUntil: "load", timeout: this.#opts.timeoutMs });
    return page.evaluate(PROBE_SOURCE(this.#opts.maxTexts)) as Promise<ProbeResult>;
  }

  async #acquire(): Promise<void> {
    if (this.#running < this.#opts.concurrency) {
      this.#running++;
      return;
    }
    await new Promise<void>((resolve) => this.#queue.push(resolve));
  }

  #release(): void {
    const next = this.#queue.shift();
    if (next) next();
    else this.#running--;
  }
}

// Text hidden in every viewport keeps its strength; hidden in only some is conditional,
// like a Tailwind `hidden md:block` element.
function merge(views: ProbeResult[], viewports: Viewport[]): RenderedText[] {
  const byIndex = new Map<number, { text: string; how: string[]; certain: boolean; seen: string[] }>();
  views.forEach((view, k) => {
    for (const h of view.hits) {
      const e = byIndex.get(h.i) ?? { text: h.text, how: [], certain: false, seen: [] };
      if (!e.how.includes(h.how)) e.how.push(h.how);
      e.certain ||= h.certain;
      e.seen.push(viewports[k]!.name);
      byIndex.set(h.i, e);
    }
  });
  return [...byIndex.values()].map((e) =>
    e.seen.length === viewports.length
      ? { text: e.text, how: e.how.join(", "), certain: e.certain }
      : { text: e.text, how: `${e.how.join(", ")} at ${e.seen.join(", ")} only`, certain: false },
  );
}
