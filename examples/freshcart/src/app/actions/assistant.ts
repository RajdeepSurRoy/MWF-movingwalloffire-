"use server";

import { ensureSessionId, readSessionId } from "@/lib/session";
import { friendlyError, getOrder } from "@/lib/store";
import { linkedPayPal, updateCheckout, type CheckoutCardData, type PlacedOrder } from "@/lib/assistant/checkout";
import { checkoutReply, orderReply } from "@/lib/assistant/tools";

// The chat's Buy buttons call these directly. They use no API quota: the
// model is only needed for understanding free-text messages. Placing the order
// is left to the assistant, after the shopper says yes in the chat.

export type BuyNowResult = { ok: true; checkout: CheckoutCardData; reply: string } | { ok: false; error: string };

export async function buyNowAction(sku: string, quantity = 1): Promise<BuyNowResult> {
  try {
    const sessionId = await ensureSessionId();
    const checkout = updateCheckout(sessionId, { items: [{ sku: String(sku), quantity: Number(quantity) }] });
    return { ok: true, checkout, reply: checkoutReply(checkout) };
  } catch (error) {
    return { ok: false, error: friendlyError(error) };
  }
}

/** The receipt for an order the chat placed via PayPal, once the shopper is back from PayPal. */
export async function placedOrderAction(orderId: string): Promise<{ order: PlacedOrder; reply: string } | null> {
  const sessionId = await readSessionId();
  const found = sessionId ? getOrder(sessionId, String(orderId)) : undefined;
  if (!found || !sessionId) return null;
  const order: PlacedOrder = {
    id: found.id,
    totalCents: found.totalCents,
    paymentMethod: found.paymentMethod as PlacedOrder["paymentMethod"],
    deliverySlot: found.deliverySlot,
  };
  const linked = linkedPayPal(sessionId) ? " Your PayPal is linked now, so next time I'll pay as soon as you say yes." : "";
  return { order, reply: orderReply(order) + linked };
}
