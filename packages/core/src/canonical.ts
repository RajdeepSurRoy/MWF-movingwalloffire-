import { createHash } from "node:crypto";

// Deterministic JSON: object keys sorted by code point, no whitespace, `undefined`
// properties dropped. Follows RFC 8785 for everything MWF hashes (strings, integers,
// booleans, null, arrays, objects). Non-finite numbers and non-plain values are rejected
// rather than silently coerced, so two different actions can never share a hash.
export function canonicalize(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new TypeError("Cannot canonicalize a non-finite number");
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) return `[${value.map((v) => canonicalize(v === undefined ? null : v)).join(",")}]`;
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new TypeError(`Cannot canonicalize a ${proto?.constructor?.name ?? "non-plain"} object`);
      }
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
    }
    default:
      throw new TypeError(`Cannot canonicalize a value of type ${typeof value}`);
  }
}

export function sha256Hex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

// Hash of an action or mandate: the value an action token is bound to.
export function hashCanonical(value: unknown): string {
  return sha256Hex(canonicalize(value));
}
