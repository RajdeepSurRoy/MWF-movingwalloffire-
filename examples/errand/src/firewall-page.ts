// Copied from the MWF SDK (packages/sdk/src/page.ts). Errand talks to the firewall only over its
// HTTP API; this file turns the page its browser shows into a context item for /v1/context/inspect.
export type ContextItem = {
  id: string;
  source: { kind: "web_page"; uri?: string };
  trust: "trusted" | "untrusted";
  content_type: "text/html";
  content: string;
  resources?: { url: string; content_type: "text/css"; content: string; redirect_to?: string }[];
};

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
  context(): { newCDPSession(page: never): Promise<CdpSession> }; // called with this page
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
// written back into its <style> blocks, since serialized HTML does not carry it.
//
// It runs in an isolated world (its own JS globals over the same DOM), never the page's own:
// there a hostile script could replace cloneNode or outerHTML and hand the firewall a clean
// page. The DOM itself is shared, so it reads only through prototype accessors, which markup
// cannot shadow (an element named "documentElement" would shadow document.documentElement).
// The copy goes into an inert document, which has no custom-element registry: a clone in the
// live document would upgrade custom elements, running the page's own constructors on the copy.
const SNAPSHOT = String.raw`(() => {
  const getter = (proto, name) => Object.getOwnPropertyDescriptor(proto, name).get;
  const setter = (proto, name) => Object.getOwnPropertyDescriptor(proto, name).set;
  const call = (fn, self, ...args) => Reflect.apply(fn, self, args);
  const textOf = getter(Node.prototype, "textContent");
  const setText = setter(Node.prototype, "textContent");
  const allIn = (root, sel) => Array.from(call(root === document ? Document.prototype.querySelectorAll : Element.prototype.querySelectorAll, root, sel));
  const sheetOf = (el) =>
    el instanceof HTMLStyleElement ? call(getter(HTMLStyleElement.prototype, "sheet"), el)
    : el instanceof SVGStyleElement ? call(getter(SVGStyleElement.prototype, "sheet"), el) : null;
  const rulesOf = (sheet) => {
    try {
      const rules = call(getter(CSSStyleSheet.prototype, "cssRules"), sheet);
      return Array.from(rules, (r) => call(getter(CSSRule.prototype, "cssText"), r)).join("\n");
    } catch { return null; }
  };
  const root = call(getter(Document.prototype, "documentElement"), document);
  const impl = call(getter(Document.prototype, "implementation"), document);
  const inert = call(DOMImplementation.prototype.createHTMLDocument, impl, "");
  const clone = call(Document.prototype.importNode, inert, root, true);
  const live = allIn(document, "style");
  const copies = allIn(clone, "style");
  if (live.length !== copies.length) throw new Error("style elements changed during the snapshot");
  live.forEach((el, i) => {
    const sheet = sheetOf(el);
    const text = sheet ? rulesOf(sheet) : null;
    if (text !== null && text !== call(textOf, el)) call(setText, copies[i], text);
  });
  const adopted = Array.from(call(getter(Document.prototype, "adoptedStyleSheets"), document) || [], rulesOf).filter((t) => t);
  if (adopted.length) {
    const style = call(Document.prototype.createElementNS, inert, "http://www.w3.org/1999/xhtml", "style");
    call(setText, style, adopted.join("\n"));
    const body = call(Element.prototype.querySelector, clone, "body");
    call(Node.prototype.appendChild, body || clone, style);
  }
  const dt = call(getter(Document.prototype, "doctype"), document);
  const dtName = dt ? call(getter(DocumentType.prototype, "name"), dt) : "";
  return {
    url: call(getter(Document.prototype, "URL"), document),
    html: (dt ? "<!DOCTYPE " + dtName + ">" : "") + call(getter(Element.prototype, "outerHTML"), clone),
  };
})()`;

export interface CdpSession {
  send(method: string, params?: object): Promise<unknown>;
  detach(): Promise<void>;
}

// The snapshot could not be taken, so script-added CSS is unknown. Not sent as a plain
// serialization, which could pass a page whose hiding lives in that CSS: the page is withheld,
// so nothing the agent derives from it can be allowed.
export class SnapshotError extends Error {
  constructor(cause: unknown) {
    super("could not take an isolated snapshot of the page (Chromium is required)", { cause });
    this.name = "SnapshotError";
  }
}

// Chromium only (CDP).
async function isolatedSnapshot(page: BrowserPage): Promise<{ url: string; html: string }> {
  const cdp = await page.context().newCDPSession(page as never);
  try {
    const { frameTree } = (await cdp.send("Page.getFrameTree")) as { frameTree: { frame: { id: string } } };
    const { executionContextId } = (await cdp.send("Page.createIsolatedWorld", { frameId: frameTree.frame.id, worldName: "mwf-snapshot" })) as {
      executionContextId: number;
    };
    const { result, exceptionDetails } = (await cdp.send("Runtime.evaluate", { expression: SNAPSHOT, contextId: executionContextId, returnByValue: true })) as {
      result: { value?: unknown };
      exceptionDetails?: unknown;
    };
    const value = result.value as { url?: unknown; html?: unknown } | undefined;
    if (exceptionDetails || typeof value?.url !== "string" || typeof value.html !== "string") throw new Error("snapshot failed");
    return { url: value.url, html: value.html };
  } finally {
    await cdp.detach().catch(() => {});
  }
}

export interface PageItemOptions {
  id: string;
  // Decides trust from the address of the document the snapshot read, never from what the agent
  // says. That address comes from the snapshot itself: read separately, a page could navigate to
  // a trusted address in between and have its own HTML tagged trusted. Default: untrusted.
  trust?: (uri: string | null) => ContextItem["trust"];
}

// Throws SnapshotError if the page cannot be snapshotted (fails closed).
export async function pageContextItem(page: BrowserPage, recorder: StylesheetRecorder, opts: PageItemOptions): Promise<ContextItem> {
  const snapshot = await isolatedSnapshot(page).catch((e: unknown) => {
    throw new SnapshotError(e);
  });
  const uri = withoutFragment(snapshot.url);
  return {
    id: opts.id,
    source: { kind: "web_page", ...(uri && { uri }) },
    trust: opts.trust?.(uri) ?? "untrusted",
    content_type: "text/html",
    content: snapshot.html,
    resources: await recorder.stylesheets(),
  };
}
