"use client";

import { useState, useTransition } from "react";
import { removeItemAction, setQuantityAction } from "@/app/actions/cart";
import { MAX_QTY_PER_ITEM } from "@/lib/catalog";

export function QuantityStepper({ sku, name, quantity, max }: { sku: string; name: string; quantity: number; max: number }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const limit = Math.min(max, MAX_QTY_PER_ITEM);

  function change(next: number) {
    setError(null);
    startTransition(async () => {
      const result = next <= 0 ? await removeItemAction(sku) : await setQuantityAction(sku, next);
      if (!result.ok) setError(result.error);
    });
  }

  return (
    <div>
      <div className={`flex items-center gap-3 ${pending ? "opacity-60" : ""}`}>
        <div className="flex items-center rounded-full border border-line bg-surface">
          <button
            type="button"
            onClick={() => change(quantity - 1)}
            disabled={pending}
            className="h-8 w-8 rounded-full text-lg leading-none hover:bg-paper"
            aria-label={`Decrease ${name}`}
          >
            −
          </button>
          <span className="w-7 text-center text-sm tabular-nums" aria-label={`Quantity ${quantity}`}>
            {quantity}
          </span>
          <button
            type="button"
            onClick={() => change(quantity + 1)}
            disabled={pending || quantity >= limit}
            className="h-8 w-8 rounded-full text-lg leading-none hover:bg-paper disabled:opacity-40"
            aria-label={`Increase ${name}`}
          >
            +
          </button>
        </div>
        <button type="button" onClick={() => change(0)} disabled={pending} className="text-sm text-muted underline-offset-2 hover:text-ink hover:underline">
          Remove
        </button>
      </div>
      {error && <p className="mt-1 text-xs text-tomato" role="alert">{error}</p>}
    </div>
  );
}
