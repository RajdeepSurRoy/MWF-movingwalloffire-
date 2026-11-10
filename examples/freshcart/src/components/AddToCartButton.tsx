"use client";

import { useState, useTransition } from "react";
import { addToCartAction } from "@/app/actions/cart";

export function AddToCartButton({
  sku,
  name,
  quantity = 1,
  disabled = false,
  compact = false,
}: {
  sku: string;
  name: string;
  quantity?: number;
  disabled?: boolean;
  compact?: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [status, setStatus] = useState<{ kind: "added" } | { kind: "error"; message: string } | null>(null);

  function add() {
    setStatus(null);
    startTransition(async () => {
      const result = await addToCartAction(sku, quantity);
      setStatus(result.ok ? { kind: "added" } : { kind: "error", message: result.error });
      if (result.ok) setTimeout(() => setStatus(null), 1600);
    });
  }

  if (disabled) {
    return (
      <span className={`${compact ? "text-xs" : "text-sm"} rounded-full bg-line px-3 py-1.5 text-muted`}>
        Sold out
      </span>
    );
  }

  const label = pending ? "Adding…" : status?.kind === "added" ? "Added ✓" : compact ? "Add" : "Add to cart";

  return (
    <div className={compact ? "" : "w-full"}>
      <button
        type="button"
        onClick={add}
        disabled={pending}
        aria-label={compact ? `Add ${name} to cart` : undefined}
        className={
          compact
            ? "rounded-full border border-green px-3.5 py-1.5 text-sm font-medium text-green transition-colors hover:bg-green hover:text-white disabled:opacity-60"
            : "w-full rounded-full bg-green px-6 py-3 font-medium text-white transition-colors hover:bg-green-dark disabled:opacity-60"
        }
      >
        {label}
      </button>
      <p aria-live="polite" className={`text-xs text-tomato ${status?.kind === "error" ? "mt-1.5" : "sr-only"}`}>
        {status?.kind === "error" ? status.message : ""}
      </p>
    </div>
  );
}
