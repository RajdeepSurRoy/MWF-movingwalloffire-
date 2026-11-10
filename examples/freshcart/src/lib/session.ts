import "server-only";
import { cookies, headers } from "next/headers";

const COOKIE = "fc_session";
const SESSION_RE = /^[a-f0-9-]{36}$/;

/** Reads the shopper's session id, or null if they haven't started one. */
export async function readSessionId(): Promise<string | null> {
  const value = (await cookies()).get(COOKIE)?.value;
  return value && SESSION_RE.test(value) ? value : null;
}

/**
 * Returns the session id, creating the cookie if needed. Only callable from
 * Server Functions and Route Handlers, where cookies can be set.
 */
export async function ensureSessionId(): Promise<string> {
  const existing = await readSessionId();
  if (existing) return existing;
  const id = crypto.randomUUID();
  (await cookies()).set(COOKIE, id, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  return id;
}

/** This site's origin (e.g. http://localhost:3000), for links that leave and come back. */
export async function requestOrigin(): Promise<string> {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, "");
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https");
  return `${proto}://${host}`;
}
