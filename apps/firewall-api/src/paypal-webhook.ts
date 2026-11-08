import type { VerifyWebhook } from "./app.js";

// Verifies a PayPal webhook delivery by asking PayPal (POST /v1/notifications/verify-webhook-signature).
// Sandbox only: a live API base is refused at startup, so no real money's events are trusted here.

export interface PayPalWebhookConfig {
  clientId: string;
  clientSecret: string;
  apiBase: string;
  webhookId: string;
  fetch?: typeof globalThis.fetch;
}

const HEADERS = {
  auth_algo: "paypal-auth-algo",
  cert_url: "paypal-cert-url",
  transmission_id: "paypal-transmission-id",
  transmission_sig: "paypal-transmission-sig",
  transmission_time: "paypal-transmission-time",
} as const;

export function assertSandbox(apiBase: string) {
  const host = new URL(apiBase).hostname;
  if (host !== "api-m.sandbox.paypal.com" && host !== "api.sandbox.paypal.com") {
    throw new Error("PAYPAL_API_BASE must be the PayPal sandbox");
  }
}

export function paypalWebhookVerifier({ clientId, clientSecret, apiBase, webhookId, fetch = globalThis.fetch }: PayPalWebhookConfig): VerifyWebhook {
  assertSandbox(apiBase);
  const base = apiBase.replace(/\/+$/, "");
  let cached: { token: string; until: number } | undefined;

  async function accessToken(): Promise<string> {
    if (cached && cached.until > Date.now()) return cached.token;
    const res = await fetch(`${base}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`PayPal OAuth answered ${res.status}`);
    const body = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new Error("PayPal OAuth gave no token");
    cached = { token: body.access_token, until: Date.now() + Math.max(0, (body.expires_in ?? 0) - 60) * 1000 };
    return cached.token;
  }

  return async (headers, event) => {
    const fields: Record<string, string> = {};
    for (const [field, header] of Object.entries(HEADERS)) {
      const v = headers[header];
      if (typeof v !== "string" || !v || v.length > 2000) return false;
      fields[field] = v;
    }
    const res = await fetch(`${base}/v1/notifications/verify-webhook-signature`, {
      method: "POST",
      headers: { authorization: `Bearer ${await accessToken()}`, "content-type": "application/json" },
      body: JSON.stringify({ ...fields, webhook_id: webhookId, webhook_event: event }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return false;
    const body = (await res.json().catch(() => ({}))) as { verification_status?: string };
    return body.verification_status === "SUCCESS";
  };
}
