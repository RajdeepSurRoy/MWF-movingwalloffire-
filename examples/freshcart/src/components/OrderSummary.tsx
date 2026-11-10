import type { Totals } from "@/lib/pricing";
import { FREE_DELIVERY_THRESHOLD_CENTS, formatPrice } from "@/lib/pricing";

export function OrderSummary({ totals, children }: { totals: Totals; children?: React.ReactNode }) {
  const toFree = FREE_DELIVERY_THRESHOLD_CENTS - totals.subtotalCents;
  return (
    <div className="rounded-2xl border border-line bg-surface p-6">
      <h2 className="font-serif text-xl font-semibold">Order summary</h2>
      <dl className="mt-4 space-y-2 text-sm">
        <div className="flex justify-between">
          <dt className="text-muted">Subtotal ({totals.itemCount} items)</dt>
          <dd className="tabular-nums">{formatPrice(totals.subtotalCents)}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-muted">Delivery</dt>
          <dd className="tabular-nums">{totals.deliveryCents ? formatPrice(totals.deliveryCents) : "Free"}</dd>
        </div>
        <div className="flex justify-between border-t border-line pt-3 text-base font-semibold">
          <dt>Total</dt>
          <dd className="tabular-nums">{formatPrice(totals.totalCents)}</dd>
        </div>
      </dl>
      {totals.itemCount > 0 && toFree > 0 && (
        <p className="mt-3 rounded-lg bg-butter/60 px-3 py-2 text-xs">
          Add {formatPrice(toFree)} more for free delivery.
        </p>
      )}
      {children && <div className="mt-5">{children}</div>}
    </div>
  );
}
