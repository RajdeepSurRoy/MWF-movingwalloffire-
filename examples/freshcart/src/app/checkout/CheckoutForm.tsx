"use client";

import { useActionState, useState } from "react";
import { checkoutAction, type CheckoutState } from "@/app/actions/cart";
import { DELIVERY_SLOTS } from "@/lib/catalog";

const field =
  "mt-1.5 w-full rounded-lg border border-line bg-surface px-3.5 py-2.5 focus:border-green focus:outline-none";

const PAYMENT_OPTIONS = [
  { value: "card", label: "Demo card", note: "Marked paid at once. No card needed, nothing is charged." },
  { value: "paypal", label: "PayPal (sandbox)", note: "Approve with a PayPal sandbox test account. No real money moves." },
  { value: "cash_on_delivery", label: "Pay on delivery", note: "Pay when your groceries arrive." },
] as const;

export function CheckoutForm({ totalLabel, paypalEnabled }: { totalLabel: string; paypalEnabled: boolean }) {
  const [state, action, pending] = useActionState<CheckoutState, FormData>(checkoutAction, {});
  const v = state.values ?? {};
  const [payment, setPayment] = useState(v.payment ?? "card");
  const options = PAYMENT_OPTIONS.filter((o) => o.value !== "paypal" || paypalEnabled);
  return (
    <form action={action} className="space-y-8">
      <fieldset className="space-y-4">
        <legend className="font-serif text-xl font-semibold">Delivery details</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block text-sm">
            Full name
            <input name="name" required minLength={2} maxLength={80} autoComplete="name" defaultValue={v.name} className={field} />
          </label>
          <label className="block text-sm">
            Email
            <input name="email" type="email" required maxLength={120} autoComplete="email" defaultValue={v.email} className={field} />
          </label>
        </div>
        <label className="block text-sm">
          Delivery address
          <textarea name="address" required minLength={8} maxLength={200} rows={2} autoComplete="street-address" defaultValue={v.address} className={field} />
        </label>
      </fieldset>

      <fieldset>
        <legend className="font-serif text-xl font-semibold">Delivery time</legend>
        <div className="mt-4 grid gap-2 sm:grid-cols-2">
          {DELIVERY_SLOTS.map((slot, i) => (
            <label
              key={slot}
              className="flex cursor-pointer items-center gap-3 rounded-lg border border-line bg-surface px-4 py-3 text-sm has-checked:border-green has-checked:bg-green-soft"
            >
              <input
                type="radio"
                name="deliverySlot"
                value={slot}
                required
                defaultChecked={v.deliverySlot ? v.deliverySlot === slot : i === 0}
                className="accent-green"
              />
              {slot}
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend className="font-serif text-xl font-semibold">Payment</legend>
        <div className="mt-4 grid gap-2">
          {options.map((o) => (
            <label
              key={o.value}
              className="flex cursor-pointer items-start gap-3 rounded-lg border border-line bg-surface px-4 py-3 text-sm has-checked:border-green has-checked:bg-green-soft"
            >
              <input
                type="radio"
                name="payment"
                value={o.value}
                checked={payment === o.value}
                onChange={() => setPayment(o.value)}
                className="mt-0.5 accent-green"
              />
              <span>
                <span className="block font-medium">{o.label}</span>
                <span className="text-muted">{o.note}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      {state.error && (
        <p role="alert" className="rounded-lg border border-tomato/30 bg-tomato/5 px-4 py-3 text-sm text-tomato">
          {state.error}
        </p>
      )}

      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-full bg-green px-6 py-3.5 font-medium text-white hover:bg-green-dark disabled:opacity-60 sm:w-auto"
      >
        {pending
          ? payment === "paypal"
            ? "Opening PayPal…"
            : "Placing order…"
          : payment === "paypal"
            ? `Continue to PayPal · ${totalLabel}`
            : payment === "card"
              ? `Pay ${totalLabel}`
              : `Place order · ${totalLabel}`}
      </button>
    </form>
  );
}
