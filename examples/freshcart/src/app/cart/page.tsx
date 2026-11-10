import type { Metadata } from "next";
import Link from "next/link";
import { readSessionId } from "@/lib/session";
import { getCart } from "@/lib/store";
import { formatPrice } from "@/lib/pricing";
import { ProductArt } from "@/components/ProductArt";
import { QuantityStepper } from "@/components/QuantityStepper";
import { OrderSummary } from "@/components/OrderSummary";
import { EmptyState } from "@/components/EmptyState";

export const metadata: Metadata = { title: "Your cart" };

export default async function CartPage() {
  const cart = getCart(await readSessionId());

  if (cart.lines.length === 0) {
    return (
      <div className="mx-auto max-w-6xl px-4 pt-10">
        <EmptyState title="Your cart is empty" body="Fill it up from the aisles, or ask the assistant to do it for you.">
          <Link href="/" className="rounded-full bg-green px-6 py-3 font-medium text-white">Start shopping</Link>
        </EmptyState>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl px-4 pt-10">
      <h1 className="font-serif text-4xl font-semibold tracking-tight">Your cart</h1>
      <div className="mt-8 grid gap-10 lg:grid-cols-[1fr_340px]">
        <ul className="divide-y divide-line border-y border-line">
          {cart.lines.map((line) => (
            <li key={line.sku} className="flex gap-4 py-5">
              <Link href={`/p/${line.sku}`} className="w-20 shrink-0 overflow-hidden rounded-lg sm:w-24">
                <ProductArt art={line.image} label={line.brand} title={line.name} />
              </Link>
              <div className="flex flex-1 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <Link href={`/p/${line.sku}`} className="font-medium hover:underline">{line.name}</Link>
                  <p className="text-sm text-muted">{line.brand} · {line.unit}</p>
                  <p className="mt-1 text-sm text-muted tabular-nums">{formatPrice(line.unitPriceCents)} each</p>
                </div>
                <div className="flex items-center justify-between gap-6 sm:flex-col sm:items-end">
                  <QuantityStepper sku={line.sku} name={line.name} quantity={line.quantity} max={line.stock} />
                  <p className="font-semibold tabular-nums">{formatPrice(line.lineTotalCents)}</p>
                </div>
              </div>
            </li>
          ))}
        </ul>
        <div className="lg:sticky lg:top-40 lg:self-start">
          <OrderSummary totals={cart.totals}>
            <Link href="/checkout" className="block rounded-full bg-green px-6 py-3 text-center font-medium text-white hover:bg-green-dark">
              Go to checkout
            </Link>
            <Link href="/" className="mt-3 block text-center text-sm text-muted hover:text-ink">Keep shopping</Link>
          </OrderSummary>
        </div>
      </div>
    </div>
  );
}
