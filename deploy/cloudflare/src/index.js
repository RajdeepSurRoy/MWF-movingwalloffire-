// Every request goes to one container (one Durable Object named "demo"), so all visitors share one
// shop, one firewall and one run queue. The container sleeps after 30 idle minutes; the next
// visitor wakes it (the page says "starting" for a minute or two while the apps boot).
import { DurableObject } from "cloudflare:workers";

const PORT = 8080;
const INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000;

export class Demo extends DurableObject {
  starting;

  constructor(ctx, env) {
    super(ctx, env);
    const container = ctx.container;
    if (container.running) {
      void ctx.blockConcurrencyWhile(() => container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS));
    }
  }

  async fetch(request) {
    // Concurrent requests share one startup and readiness check.
    this.starting ??= this.startAndWaitForPort().finally(() => {
      this.starting = undefined;
    });
    try {
      await this.starting;
    } catch {
      return new Response("The demo is starting. Reload in a minute.", { status: 503, headers: { "retry-after": "30", "content-type": "text/plain" } });
    }
    const url = new URL(request.url);
    url.protocol = "http:";
    url.host = "container";
    const forwarded = new Request(url, request);
    forwarded.headers.delete("host");
    return this.ctx.container.getTcpPort(PORT).fetch(forwarded);
  }

  async startAndWaitForPort() {
    const container = this.ctx.container;
    if (!container.running) {
      // No Internet access: everything the demo needs is inside the image.
      container.start({ image: container.images.base, instance: "standard-1", enableInternet: false });
    }
    await container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
    const port = container.getTcpPort(PORT);
    let lastError;
    for (let attempt = 0; attempt < 150; attempt++) {
      try {
        const response = await port.fetch("http://container/health", { signal: AbortSignal.timeout(1000) });
        await response.body?.cancel();
        if (response.ok) return;
        lastError = new Error(`health returned ${response.status}`);
      } catch (error) {
        lastError = error;
      }
      await scheduler.wait(200);
    }
    throw new Error("The container did not become ready", { cause: lastError });
  }
}

export default {
  fetch(request, env) {
    return env.DEMO.getByName("demo").fetch(request);
  },
};
