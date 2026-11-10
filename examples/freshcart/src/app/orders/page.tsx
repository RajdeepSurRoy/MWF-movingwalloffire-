import type { Metadata } from "next";
import Link from "next/link";
import { readSessionId } from "@/lib/session";
import { listOrders } from "@/lib/store";
import { formatPrice } from "@/lib/pricing";
import { EmptyState } from "@/components/EmptyState";
import { StatusBadge } from "@/components/StatusBadge";

export const metadata: Metadata = { title: "Your orders" };

const dateFmt = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" });

export default async function OrdersPage() {
  const orders = listOrders(await readSessionId());
  return (
    <div className="mx-auto max-w-3xl px-4 pt-10">
      <h1 className="font-serif text-4xl font-semibold tracking-tight">Your orders</h1>
      {orders.length === 0 ? (
        <EmptyState title="No orders yet" body="When you place an order, on the site or through the assistant, it shows up here.">
          <Link href="/" className="rounded-full bg-green px-6 py-3 font-medium text-white">Start shopping</Link>
        </EmptyState>
      ) : (
        <ul className="mt-8 divide-y divide-line border-y border-line">
          {orders.map((o) => (
            <li key={o.id}>
              <Link href={`/orders/${o.id}`} className="flex items-center justify-between gap-4 py-5">
                <div>
                  <div className="flex items-center gap-3">
                    <span className="font-mono text-sm font-medium">{o.id}</span>
                    <StatusBadge status={o.status} />
                  </div>
                  <p className="mt-1 text-sm text-muted">
                    {dateFmt.format(o.createdAt)} · {o.items.reduce((n, i) => n + i.quantity, 0)} items
                    {o.placedVia === "assistant" && " · via assistant"}
                  </p>
                </div>
                <span className="font-semibold tabular-nums">{formatPrice(o.totalCents)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
