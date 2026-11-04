import type { ContextItem } from "@mwf/core";

// Turning a page the agent's browser loaded into a context item for /v1/context/inspect, with
// the stylesheets that browser received. The firewall never fetches a page's CSS itself, so
// these are what lets it see hiding done in linked stylesheets; a page whose linked CSS is
// missing is held for REVIEW (CTX.STYLES_NOT_PROVIDED).
//
// Written against the shape of Playwright's Page/Response, so the SDK does not depend on it.

export interface BrowserRequest {
  url(): string;
  resourceType(): string;
  redirectedFrom(): BrowserRequest | null;
}

export interface BrowserResponse {
  url(): string;
  status(): number;
  request(): BrowserRequest;
  text(): Promise<string>;
}

export interface BrowserPage {
  url(): string;
  content(): Promise<string>;
  evaluate<T>(expression: string): Promise<T>;
  on(event: "response", listener: (response: BrowserResponse) => void): unknown;
  off(event: "response", listener: (response: BrowserResponse) => void): unknown;
}

export type Stylesheet = NonNullable<ContextItem["resources"]>[number];

// The API's limits on `resources` (see ContextItem in @mwf/core).
export const RESOURCE_LIMITS = { count: 50, each: 1_000_000, total: 2_000_000 };

const withoutFragment = (url: string): string | null => {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    return u.href;
  } catch {
    return null;
  }
};

export class StylesheetRecorder {
  readonly #page: BrowserPage;
  // By URL. A redirect chain is kept as redirect entries leading to the final sheet, so the
  // firewall resolves the sheet's relative @imports against where it really came from.
  readonly #sheets = new Map<string, { body: Promise<string>; redirect?: string }>();
  readonly #listener = (response: BrowserResponse) => this.#record(response);

  constructor(page: BrowserPage) {
    this.#page = page;
    page.on("response", this.#listener);
  }

  #record(response: BrowserResponse): void {
    const request = response.request();
    if (request.resourceType() !== "stylesheet") return;
    const status = response.status();
    if (status >= 300 && status < 400) return; // the redirect's target arrives as its own response
    // A failed load applied no CSS in the agent's browser either: send it as empty.
    const body = status >= 200 && status < 300 ? response.text().catch(() => "") : Promise.resolve("");
    const final = withoutFragment(request.url());
    if (!final) return;
    if (!this.#sheets.has(final)) this.#sheets.set(final, { body });
    let next = final;
    for (let r = request.redirectedFrom(); r; r = r.redirectedFrom()) {
      const url = withoutFragment(r.url());
      if (!url) break;
      if (!this.#sheets.has(url)) this.#sheets.set(url, { body: Promise.resolve(""), redirect: next });
      next = url;
    }
  }

  // Every stylesheet received so far, within the API's limits, in the order they arrived.
  // Sheets that do not fit are left out; the firewall then reports them missing (REVIEW).
  async stylesheets(): Promise<Stylesheet[]> {
    const out: Stylesheet[] = [];
    let total = 0;
    for (const [url, sheet] of this.#sheets) {
      const content = await sheet.body;
      if (out.length >= RESOURCE_LIMITS.count || content.length > RESOURCE_LIMITS.each || total + content.length > RESOURCE_LIMITS.total) continue;
      total += content.length;
      out.push({ url, content_type: "text/css", content, ...(sheet.redirect && { redirect_to: sheet.redirect }) });
    }
    return out;
  }

  stop(): void {
    this.#page.off("response", this.#listener);
  }
}

// Start recording before the page navigates, or its stylesheets are missed.
export function recordStylesheets(page: BrowserPage): StylesheetRecorder {
  return new StylesheetRecorder(page);
}

// The page as currently drawn, with CSS that scripts changed (insertRule, adoptedStyleSheets)
// written back into its <style> blocks, since serialized HTML does not carry it. It runs in the
// page, so a hostile script could interfere; if it fails, the plain serialization is used.
const SNAPSHOT = `(() => {
  const rulesOf = (sheet) => { try { return Array.from(sheet.cssRules, (r) => r.cssText).join("\\n"); } catch { return null; } };
  const clone = document.documentElement.cloneNode(true);
  const live = Array.from(document.querySelectorAll("style"));
  const copies = Array.from(clone.querySelectorAll("style"));
  live.forEach((el, i) => {
    const text = el.sheet ? rulesOf(el.sheet) : null;
    if (text !== null && copies[i] && text !== el.textContent) copies[i].textContent = text;
  });
  const adopted = (document.adoptedStyleSheets || []).map(rulesOf).filter((t) => t);
  if (adopted.length) {
    const style = document.createElement("style");
    style.textContent = adopted.join("\\n");
    (clone.querySelector("body") || clone).appendChild(style);
  }
  const dt = document.doctype;
  return (dt ? "<!DOCTYPE " + dt.name + ">" : "") + clone.outerHTML;
})()`;

export interface PageItemOptions {
  id: string;
  // Set by the SDK from where the page came from, never by the agent (docs/implementation-plan.md, M5).
  trust?: ContextItem["trust"];
}

export async function pageContextItem(page: BrowserPage, recorder: StylesheetRecorder, opts: PageItemOptions): Promise<ContextItem> {
  const content = await page.evaluate<string>(SNAPSHOT).catch(() => page.content());
  const uri = withoutFragment(page.url());
  return {
    id: opts.id,
    source: { kind: "web_page", ...(uri && { uri }) },
    trust: opts.trust ?? "untrusted",
    content_type: "text/html",
    content,
    resources: await recorder.stylesheets(),
  };
}
