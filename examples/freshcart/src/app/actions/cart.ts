"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { ensureSessionId, requestOrigin } from "@/lib/session";
import { startPayPalPayment } from "@/lib/paypal";
import {
  addToCart,
  friendlyError,
  getCart,
  placeOrder,
  removeFromCart,
  setCartQuantity,
} from "@/lib/store";

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string };

export async function addToCartAction(sku: string, quantity: number): Promise<ActionResult> {
  try {
    const sessionId = await ensureSessionId();
    addToCart(sessionId, String(sku), Number(quantity));
    refresh();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: friendlyError(error) };
  }
}

export async function setQuantityAction(sku: string, quantity: number): Promise<ActionResult> {
  try {
    const sessionId = await ensureSessionId();
    setCartQuantity(sessionId, String(sku), Number(quantity));
    refresh();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: friendlyError(error) };
  }
}

export async function removeItemAction(sku: string): Promise<ActionResult> {
  try {
    const sessionId = await ensureSessionId();
    removeFromCart(sessionId, String(sku));
    refresh();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: friendlyError(error) };
  }
}

export type CheckoutState = { error?: string; values?: Record<string, string> };

export async function checkoutAction(_prev: CheckoutState, formData: FormData): Promise<CheckoutState> {
  const values = {
    name: String(formData.get("name") ?? ""),
    email: String(formData.get("email") ?? ""),
    address: String(formData.get("address") ?? ""),
    deliverySlot: String(formData.get("deliverySlot") ?? ""),
    payment: String(formData.get("payment") ?? "cash_on_delivery"),
  };
  let target: string;
  try {
    const sessionId = await ensureSessionId();
    if (values.payment === "paypal") {
      // The cart is frozen into the PayPal payment; the order is placed when
      // PayPal sends the shopper back (see /api/paypal/return).
      const items = getCart(sessionId).lines.map((l) => ({ sku: l.sku, quantity: l.quantity }));
      if (items.length === 0) return { error: "Your cart is empty.", values };
      const { name, email, address, deliverySlot } = values;
      target = (
        await startPayPalPayment(sessionId, {
          items,
          fromCart: true,
          details: { name, email, address, deliverySlot },
          placedVia: "web",
          origin: await requestOrigin(),
          returnPath: "/checkout",
        })
      ).approveUrl;
    } else {
      const paymentMethod = values.payment === "card" ? "card" : "cash_on_delivery";
      target = `/orders/${placeOrder(sessionId, values, "web", undefined, { paymentMethod }).id}?placed=1`;
    }
  } catch (error) {
    return { error: friendlyError(error), values };
  }
  // redirect() works by throwing, so it stays outside the try block.
  redirect(target);
}
