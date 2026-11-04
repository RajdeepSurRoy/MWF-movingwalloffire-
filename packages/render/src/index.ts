import type { RenderReport, RenderedText } from "@mwf/core";
import { type Browser, type BrowserContext, chromium } from "playwright";
import { type ProbeResult, probe } from "./probe.js";

// Renders untrusted HTML in headless Chromium to find text a person would not see.
// The page is sandboxed: its scripts are disabled and every network request is refused, so a
// page cannot phone home, load more content, or behave differently for the firewall.
// Stylesheets the page links to are not loaded either (see docs/implementation-plan.md, M5).

// Sent as source text. tsx/esbuild may wrap named functions in a `__name` helper that does not
// exist in the page, so a no-op one is defined around the probe.
const PROBE_SOURCE = (maxTexts: number) => `(() => { const __name = (f) => f; return (${probe.toString()})(${maxTexts}); })()`;

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
}

export class PageRenderer {
  readonly #opts: Required<RendererOptions>;
  #browser: Promise<Browser> | undefined;
  #running = 0;
  readonly #queue: (() => void)[] = [];

  constructor(opts: RendererOptions = {}) {
    this.#opts = {
      timeoutMs: opts.timeoutMs ?? 8000,
      maxHtmlChars: opts.maxHtmlChars ?? 2_000_000,
      maxTexts: opts.maxTexts ?? 20_000,
      concurrency: opts.concurrency ?? 4,
      viewports: opts.viewports ?? VIEWPORTS,
      sandbox: opts.sandbox ?? true,
    };
  }

  // Never throws: any failure is a report with ok: false, which the scanner turns into a REVIEW.
  async render(html: string): Promise<RenderReport> {
    if (html.length > this.#opts.maxHtmlChars) return { ok: false, error: "page too large to render" };
    await this.#acquire();
    const run: Run = { done: false, contexts: [] };
    let timer: NodeJS.Timeout | undefined;
    let work: Promise<unknown> = Promise.resolve();
    try {
      const browser = await this.#launch();
      const views = Promise.all(this.#opts.viewports.map((v) => this.#probe(browser, run, html, v)));
      work = views.catch(() => {}); // after a timeout the closed contexts make it reject
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${this.#opts.timeoutMs} ms`)), this.#opts.timeoutMs);
      });
      const done = await Promise.race([views, timeout]);
      if (done.some((v) => v.truncated)) return { ok: false, error: `more than ${this.#opts.maxTexts} text nodes` };
      return { ok: true, viewports: this.#opts.viewports.map((v) => v.name), hidden: merge(done, this.#opts.viewports) };
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

  async close(): Promise<void> {
    const browser = this.#browser;
    this.#browser = undefined;
    if (browser) await (await browser.catch(() => undefined))?.close();
  }

  async #launch(): Promise<Browser> {
    const current = this.#browser && (await this.#browser.catch(() => undefined));
    if (current?.isConnected()) return current;
    this.#browser = chromium.launch({ headless: true, chromiumSandbox: this.#opts.sandbox });
    return this.#browser;
  }

  async #probe(browser: Browser, run: Run, html: string, v: Viewport): Promise<ProbeResult> {
    const context = await browser.newContext({
      javaScriptEnabled: false,
      offline: true,
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
    await context.route("**/*", (route) => route.abort("blockedbyclient"));
    const page = await context.newPage();
    await page.setContent(html, { waitUntil: "domcontentloaded", timeout: this.#opts.timeoutMs });
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
