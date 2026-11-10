import type { Metadata } from "next";
import Link from "next/link";
import { readSessionId } from "@/lib/session";
import { getCart } from "@/lib/store";
import { formatPrice } from "@/lib/pricing";
import { OrderSummary } from "@/components/OrderSummary";
import { EmptyState } from "@/components/EmptyState";
import { paypalEnabled } from "@/lib/paypal";
import { CheckoutForm } from "./CheckoutForm";

const PAYPAL_NOTICES: Record<string, string> = {
  cancelled: "You cancelled the PayPal payment. Nothing was charged; your cart is still here.",
  failed: "PayPal couldn't complete the payment. Nothing was ordered. Please try again or pick another payment method.",
};

export const metadata: Metadata = { title: "Checkout" };

export default async function CheckoutPage({ searchParams }: PageProps<"/checkout">) {
  const paypalStatus = (await searchParams).paypal;
  const notice = typeof paypalStatus === "string" ? PAYPAL_NOTICES[paypalStatus] : undefined;
  const cart = getCart(await readSessionId());
  if (cart.lines.length === 0) {
    return (
      <div className="mx-auto max-w-6xl px-4 pt-10">
        <EmptyState title="Nothing to check out" body="Your cart is empty. Add a few things first.">
          <Link href="/" className="rounded-full bg-green px-6 py-3 font-medium text-white">Start shopping</Link>
        </EmptyState>
      </div>
    );
  }
  return (
    <div className="mx-auto max-w-6xl px-4 pt-10">
      <h1 className="font-serif text-4xl font-semibold tracking-tight">Checkout</h1>
      {notice && (
        <p role="status" className="mt-4 rounded-lg border border-tomato/30 bg-tomato/5 px-4 py-3 text-sm text-tomato">
          {notice}
        </p>
      )}
      <div className="mt-8 grid gap-10 lg:grid-cols-[1fr_340px]">
        <CheckoutForm totalLabel={formatPrice(cart.totals.totalCents)} paypalEnabled={paypalEnabled()} />
        <div className="lg:sticky lg:top-40 lg:self-start">
          <OrderSummary totals={cart.totals}>
            <ul className="space-y-1.5 border-t border-line pt-4 text-sm">
              {cart.lines.map((l) => (
                <li key={l.sku} className="flex justify-between gap-3">
                  <span className="text-muted">{l.quantity} × {l.name}</span>
                  <span className="tabular-nums">{formatPrice(l.lineTotalCents)}</span>
                </li>
              ))}
            </ul>
          </OrderSummary>
        </div>
      </div>
    </div>
  );
}
