import { PaymentArgs, type PreparedEffect, type ProposedAction } from "@mwf/core";
import type { TwoPhase } from "@mwf/sdk";

// The demo business's own PayPal code, not part of MWF. It is what a real agent platform already
// has: authorize, capture, void with its own sandbox app and a vaulted buyer wallet (no buyer
// present). It reports each authorization to the firewall as a generic prepared effect, then does
// what the firewall's answer says. Sandbox only: a live API base is refused.

export class PayPalError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    // PayPal's error name and debug id only, never the request or response body.
    readonly issue?: string,
  ) {
    super(message);
    this.name = "PayPalError";
  }
}

export interface PayPalOptions {
  clientId: string;
  clientSecret: string;
  apiBase: string;
  // The buyer's vaulted wallet (payment token id), saved once with the buyer's approval.
  vaultId: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

const SANDBOX_HOSTS = new Set(["api-m.sandbox.paypal.com", "api.sandbox.paypal.com"]);

interface Authorization {
  id: string;
  status: string;
  amount?: { currency_code: string; value: string };
}
interface Order {
  id: string;
  status: string;
  purchase_units?: { payee?: { email_address?: string; merchant_id?: string }; payments?: { authorizations?: Authorization[] } }[];
}

export class PayPalSandbox {
  readonly #o: Required<Omit<PayPalOptions, "fetch">> & { fetch: typeof globalThis.fetch };
  #token: { value: string; until: number } | undefined;

  constructor({ fetch = globalThis.fetch, timeoutMs = 20_000, ...rest }: PayPalOptions) {
    const url = new URL(rest.apiBase);
    if (url.protocol !== "https:" || !SANDBOX_HOSTS.has(url.hostname)) throw new PayPalError("PayPal apiBase must be the sandbox");
    if (!rest.clientId || !rest.clientSecret || !rest.vaultId) throw new PayPalError("PayPal clientId, clientSecret and vaultId are required");
    this.#o = { ...rest, apiBase: url.origin, fetch, timeoutMs };
  }

  async #accessToken(): Promise<string> {
    if (this.#token && this.#token.until > Date.now()) return this.#token.value;
    const res = await this.#o.fetch(`${this.#o.apiBase}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(`${this.#o.clientId}:${this.#o.clientSecret}`).toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
      signal: AbortSignal.timeout(this.#o.timeoutMs),
    });
    if (!res.ok) throw new PayPalError("PayPal OAuth failed", res.status);
    const body = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new PayPalError("PayPal OAuth gave no token", res.status);
    this.#token = { value: body.access_token, until: Date.now() + Math.max(0, (body.expires_in ?? 0) - 60) * 1000 };
    return this.#token.value;
  }

  // requestId is PayPal-Request-Id: a retry with the same id returns the first result instead of
  // creating a second order, authorization or capture.
  async #call<T>(method: "GET" | "POST", path: string, requestId: string | null, body?: unknown): Promise<T> {
    const res = await this.#o.fetch(this.#o.apiBase + path, {
      method,
      headers: {
        authorization: `Bearer ${await this.#accessToken()}`,
        "content-type": "application/json",
        prefer: "return=representation",
        ...(requestId && { "paypal-request-id": requestId }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(this.#o.timeoutMs),
    });
    const text = await res.text();
    let json: unknown = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      throw new PayPalError(`PayPal gave a malformed answer at ${method} ${path.split("/").slice(0, 4).join("/")}`, res.status);
    }
    if (!res.ok) {
      const e = json as { name?: string; debug_id?: string };
      throw new PayPalError(`PayPal answered ${res.status}`, res.status, [e.name, e.debug_id].filter(Boolean).join(" ") || undefined);
    }
    return json as T;
  }

  // Holds the action's total. Returns what PayPal reports, not what the action says.
  async authorize(action: ProposedAction, idempotencyKey: string): Promise<PreparedEffect> {
    const args = PaymentArgs.parse(action.args);
    const order = await this.#call<Order>("POST", "/v2/checkout/orders", idempotencyKey, {
      intent: "AUTHORIZE",
      purchase_units: [
        {
          reference_id: args.merchant.id.slice(0, 256),
          // Links PayPal's webhooks for this order back to the approved action.
          custom_id: idempotencyKey,
          description: `${args.merchant.name}: ${args.items.length} item(s)`.slice(0, 127),
          amount: { currency_code: args.total.currency, value: args.total.value },
          ...(args.merchant.payee_email && { payee: { email_address: args.merchant.payee_email } }),
        },
      ],
      payment_source: { paypal: { vault_id: this.#o.vaultId } },
    });
    let authorization = order.purchase_units?.[0]?.payments?.authorizations?.[0];
    if (!authorization) {
      // With a vaulted wallet there is no buyer step: an APPROVED order is authorized directly.
      if (order.status !== "APPROVED") throw new PayPalError(`PayPal order needs buyer action (status ${order.status})`);
      const authorized = await this.#call<Order>("POST", `/v2/checkout/orders/${encodeURIComponent(order.id)}/authorize`, `${idempotencyKey}-authorize`, {});
      authorization = authorized.purchase_units?.[0]?.payments?.authorizations?.[0];
    }
    if (!authorization?.amount) throw new PayPalError("PayPal returned no authorization");
    // The payee as PayPal records it on the order.
    const full = await this.#call<Order>("GET", `/v2/checkout/orders/${encodeURIComponent(order.id)}`, null);
    const payee = full.purchase_units?.[0]?.payee;
    return {
      system: "paypal",
      reference: authorization.id,
      ready: authorization.status === "CREATED",
      status: authorization.status,
      effect: {
        amount: { value: authorization.amount.value, currency: authorization.amount.currency_code },
        payee: { ...(payee?.email_address && { email: payee.email_address }), ...(payee?.merchant_id && { id: payee.merchant_id }) },
      },
      external_ids: { order_id: order.id },
    };
  }

  async capture(prepared: PreparedEffect, idempotencyKey: string) {
    const c = await this.#call<{ id: string; status: string }>(
      "POST",
      `/v2/payments/authorizations/${encodeURIComponent(prepared.reference)}/capture`,
      `${idempotencyKey}-capture`,
      { final_capture: true },
    );
    return { capture_id: c.id, status: c.status };
  }

  async void(prepared: PreparedEffect, idempotencyKey: string) {
    const path = `/v2/payments/authorizations/${encodeURIComponent(prepared.reference)}`;
    await this.#call("POST", `${path}/void`, `${idempotencyKey}-void`);
    const a = await this.#call<Authorization>("GET", path, null);
    return { status: a.status };
  }
}

export interface PaymentReceipt {
  order_id: string;
  authorization_id: string;
  capture_id: string;
  status: string;
}

// How this business plugs its PayPal code into the SDK's two-phase commit.
export function paypalTwoPhase(paypal: PayPalSandbox): TwoPhase<PaymentReceipt> {
  return {
    appliesTo: (action) => action.type.startsWith("payment."),
    prepare: (action, key) => paypal.authorize(action, key),
    execute: async (prepared, _action, key) => {
      const c = await paypal.capture(prepared, key);
      const order_id = prepared.external_ids?.order_id ?? "";
      return { receipt: { order_id, authorization_id: prepared.reference, ...c }, status: c.status, external_ids: { capture_id: c.capture_id } };
    },
    cancel: (prepared, key) => paypal.void(prepared, key),
  };
}
