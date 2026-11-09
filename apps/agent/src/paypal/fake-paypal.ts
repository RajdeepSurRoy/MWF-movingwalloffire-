import { randomUUID } from "node:crypto";

// An in-memory stand-in for the PayPal sandbox endpoints the demo business's PayPalSandbox uses, as a `fetch`.
// For tests and offline demos only: it follows the documented request and response shapes,
// including PayPal-Request-Id idempotency, but it is not PayPal.

interface Auth {
  id: string;
  order_id: string;
  status: "CREATED" | "CAPTURED" | "VOIDED";
  amount: { currency_code: string; value: string };
}

export interface FakePayPalOptions {
  // The sandbox business account paid when an order names no payee.
  defaultPayee?: string;
  // Changes what the "provider" reports, to test that the firewall checks it.
  tamper?: (order: { amount: { currency_code: string; value: string }; payee: string }) => void;
}

export class FakePayPal {
  readonly calls: { method: string; path: string; requestId: string | null }[] = [];
  readonly orders = new Map<string, { id: string; payee: string; auth: Auth; custom_id?: string }>();
  readonly authorizations = new Map<string, Auth>();
  readonly captures = new Map<string, { id: string; authorization_id: string; status: string }>();
  readonly #replies = new Map<string, { status: number; body: unknown }>();
  readonly #o: FakePayPalOptions;

  constructor(options: FakePayPalOptions = {}) {
    this.#o = options;
  }

  readonly fetch = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const { pathname } = new URL(String(url));
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const requestId = headers.get("paypal-request-id");
    this.calls.push({ method, path: pathname, requestId });
    if (pathname === "/v1/oauth2/token") {
      if (!headers.get("authorization")?.startsWith("Basic ")) return json(401, { name: "AUTHENTICATION_FAILURE" });
      return json(200, { access_token: `fake-${randomUUID()}`, expires_in: 32400 });
    }
    if (!headers.get("authorization")?.startsWith("Bearer ")) return json(401, { name: "AUTHENTICATION_FAILURE" });
    // A repeated PayPal-Request-Id returns the first answer and changes nothing.
    const replayKey = requestId && `${method} ${pathname} ${requestId}`;
    if (replayKey && this.#replies.has(replayKey)) {
      const r = this.#replies.get(replayKey)!;
      return json(r.status, r.body);
    }
    const reply = this.#route(method, pathname, init?.body ? JSON.parse(String(init.body)) : undefined);
    if (replayKey && reply.status < 500) this.#replies.set(replayKey, reply);
    return reply.status === 204 ? new Response(null, { status: 204 }) : json(reply.status, reply.body);
  }) as typeof globalThis.fetch;

  #orderBody(o: { id: string; payee: string; auth: Auth }) {
    return {
      id: o.id,
      status: "COMPLETED",
      purchase_units: [{ payee: { email_address: o.payee, merchant_id: "FAKEMERCHANT1" }, payments: { authorizations: [o.auth] } }],
    };
  }

  #route(method: string, path: string, body: any): { status: number; body: unknown } {
    if (method === "POST" && path === "/v2/checkout/orders") {
      if (body?.intent !== "AUTHORIZE" || !body?.payment_source?.paypal?.vault_id) return { status: 422, body: { name: "UNPROCESSABLE_ENTITY" } };
      const unit = body.purchase_units[0];
      const draft = { amount: { ...unit.amount }, payee: unit.payee?.email_address ?? this.#o.defaultPayee ?? "merchant@business.example.com" };
      this.#o.tamper?.(draft);
      const id = `FAKEORDER${this.orders.size + 1}`;
      const auth: Auth = { id: `FAKEAUTH${this.orders.size + 1}`, order_id: id, status: "CREATED", amount: draft.amount };
      const order = { id, payee: draft.payee, auth, custom_id: unit.custom_id };
      this.orders.set(id, order);
      this.authorizations.set(auth.id, auth);
      return { status: 201, body: this.#orderBody(order) };
    }
    let m = /^\/v2\/checkout\/orders\/([^/]+)$/.exec(path);
    if (method === "GET" && m) {
      const o = this.orders.get(decodeURIComponent(m[1]!));
      return o ? { status: 200, body: this.#orderBody(o) } : { status: 404, body: { name: "RESOURCE_NOT_FOUND" } };
    }
    m = /^\/v2\/payments\/authorizations\/([^/]+)(\/capture|\/void)?$/.exec(path);
    const auth = m && this.authorizations.get(decodeURIComponent(m[1]!));
    if (!m || !auth) return { status: 404, body: { name: "RESOURCE_NOT_FOUND" } };
    if (method === "GET" && !m[2]) return { status: 200, body: auth };
    if (method === "POST" && m[2] === "/capture") {
      if (auth.status !== "CREATED") return { status: 422, body: { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "AUTHORIZATION_ALREADY_CAPTURED" }] } };
      auth.status = "CAPTURED";
      const capture = { id: `FAKECAPTURE${this.captures.size + 1}`, authorization_id: auth.id, status: "COMPLETED" };
      this.captures.set(capture.id, capture);
      return { status: 201, body: { id: capture.id, status: capture.status, amount: auth.amount } };
    }
    if (method === "POST" && m[2] === "/void") {
      if (auth.status !== "CREATED") return { status: 422, body: { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "PREVIOUSLY_CAPTURED" }] } };
      auth.status = "VOIDED";
      return { status: 204, body: null };
    }
    return { status: 405, body: { name: "METHOD_NOT_SUPPORTED" } };
  }
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
