"use client";

import { useState } from "react";
import { AddToCartButton } from "./AddToCartButton";
import { MAX_QTY_PER_ITEM } from "@/lib/catalog";

export function ProductPurchase({ sku, name, stock }: { sku: string; name: string; stock: number }) {
  const [qty, setQty] = useState(1);
  const limit = Math.min(stock, MAX_QTY_PER_ITEM);
  if (stock === 0) return <AddToCartButton sku={sku} name={name} disabled />;
  return (
    <div className="flex items-center gap-3">
      <div className="flex items-center rounded-full border border-line bg-surface">
        <button type="button" className="h-11 w-11 rounded-full text-xl" onClick={() => setQty((q) => Math.max(1, q - 1))} aria-label="Decrease quantity">
          −
        </button>
        <span className="w-8 text-center tabular-nums" aria-live="polite">{qty}</span>
        <button type="button" className="h-11 w-11 rounded-full text-xl disabled:opacity-40" onClick={() => setQty((q) => Math.min(limit, q + 1))} disabled={qty >= limit} aria-label="Increase quantity">
          +
        </button>
      </div>
      <div className="flex-1">
        <AddToCartButton sku={sku} name={name} quantity={qty} />
      </div>
    </div>
  );
}
