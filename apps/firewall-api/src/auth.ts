import { randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { sha256Hex } from "@mwf/core";

const KEY_PREFIX = "mwf_sk_test_";

// API keys are 256-bit random secrets, so a plain SHA-256 is enough to store them:
// there is nothing to brute-force. Only the hash is kept; the key is shown once.
export function hashApiKey(key: string): string {
  return sha256Hex(key);
}

export function createApiKey(db: DatabaseSync, tenantId: string, label: string): { id: string; key: string } {
  const key = KEY_PREFIX + randomBytes(32).toString("base64url");
  const id = randomUUID();
  db.prepare(
    "INSERT INTO api_keys (id, tenant_id, key_hash, key_prefix, label, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(id, tenantId, hashApiKey(key), key.slice(0, KEY_PREFIX.length + 4), label, new Date().toISOString());
  return { id, key };
}

// Returns the tenant for a valid, unrevoked key, or null.
export function authenticate(db: DatabaseSync, authorization: string | undefined): string | null {
  const match = /^Bearer (\S+)$/.exec(authorization ?? "");
  if (!match?.[1]?.startsWith(KEY_PREFIX)) return null;
  const row = db
    .prepare("SELECT tenant_id FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL")
    .get(hashApiKey(match[1])) as { tenant_id: string } | undefined;
  return row?.tenant_id ?? null;
}
