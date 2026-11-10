import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { readSessionId } from "@/lib/session";
import { getOrder } from "@/lib/store";
import { formatPrice } from "@/lib/pricing";
import { StatusBadge } from "@/components/StatusBadge";

export const metadata: Metadata = { title: "Order details" };

const PAID_NOTE: Record<string, string> = {
  card: "Paid with the demo card.",
  paypal: "Paid with PayPal (sandbox).",
};
const PAYMENT_LINE: Record<string, string> = {
  card: "Paid with demo card (nothing was charged)",
  paypal: "Paid with PayPal sandbox (no real money)",
};

const dateFmt = new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeStyle: "short" });

export default async function OrderPage({ params, searchParams }: PageProps<"/orders/[id]">) {
  const { id } = await params;
  const justPlaced = (await searchParams).placed === "1";
  const order = getOrder(await readSessionId(), id);
  if (!order) notFound();

  return (
    <div className="mx-auto max-w-3xl px-4 pt-10">
      {justPlaced && (
        <div className="mb-8 rounded-2xl bg-green-soft px-6 py-5">
          <p className="font-serif text-2xl font-semibold text-green">
            Thanks, {order.customerName.split(" ")[0]}! Your order is in.
          </p>
          <p className="mt-1 text-sm">
            We&apos;ll deliver {order.deliverySlot.toLowerCase()}. {PAID_NOTE[order.paymentMethod] ?? "You'll pay on delivery."}
          </p>
        </div>
      )}
      <Link href="/orders" className="text-sm text-muted hover:text-ink">← All orders</Link>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <h1 className="font-serif text-3xl font-semibold tracking-tight">
          Order <span className="font-mono text-2xl">{order.id}</span>
        </h1>
        <StatusBadge status={order.status} />
      </div>
      <p className="mt-1 text-sm text-muted">
        Placed {dateFmt.format(order.createdAt)}
        {order.placedVia === "assistant" ? " with the shopping assistant" : ""}
      </p>

      <div className="mt-8 grid gap-6 sm:grid-cols-2">
        <div className="rounded-xl border border-line bg-surface p-5 text-sm">
          <h2 className="font-medium">Delivering to</h2>
          <p className="mt-2">{order.customerName}</p>
          <p className="text-muted">{order.address}</p>
          <p className="text-muted">{order.email}</p>
        </div>
        <div className="rounded-xl border border-line bg-surface p-5 text-sm">
          <h2 className="font-medium">Delivery time</h2>
          <p className="mt-2">{order.deliverySlot}</p>
          <h2 className="mt-4 font-medium">Payment</h2>
          <p className="mt-1 text-muted">
            {PAYMENT_LINE[order.paymentMethod] ?? "Pay on delivery (demo)"}
          </p>
          {order.paymentRef && (
            <p className="mt-0.5 font-mono text-xs text-muted">PayPal capture {order.paymentRef}</p>
          )}
        </div>
      </div>

      <table className="mt-8 w-full text-sm">
        <caption className="sr-only">Items in this order</caption>
        <thead className="border-b border-line text-left text-muted">
          <tr>
            <th className="py-2 font-normal">Item</th>
            <th className="py-2 text-right font-normal">Qty</th>
            <th className="py-2 text-right font-normal">Price</th>
            <th className="py-2 text-right font-normal">Total</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {order.items.map((i) => (
            <tr key={i.sku}>
              <td className="py-3">
                <Link href={`/p/${i.sku}`} className="hover:underline">{i.name}</Link>
                <span className="block text-xs text-muted">{i.unit}</span>
              </td>
              <td className="py-3 text-right tabular-nums">{i.quantity}</td>
              <td className="py-3 text-right tabular-nums">{formatPrice(i.unitPriceCents)}</td>
              <td className="py-3 text-right tabular-nums">{formatPrice(i.lineTotalCents)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot className="border-t border-line">
          <tr>
            <td colSpan={3} className="pt-3 text-right text-muted">Subtotal</td>
            <td className="pt-3 text-right tabular-nums">{formatPrice(order.subtotalCents)}</td>
          </tr>
          <tr>
            <td colSpan={3} className="text-right text-muted">Delivery</td>
            <td className="text-right tabular-nums">{order.deliveryCents ? formatPrice(order.deliveryCents) : "Free"}</td>
          </tr>
          <tr className="text-base font-semibold">
            <td colSpan={3} className="pt-2 text-right">Total</td>
            <td className="pt-2 text-right tabular-nums">{formatPrice(order.totalCents)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
