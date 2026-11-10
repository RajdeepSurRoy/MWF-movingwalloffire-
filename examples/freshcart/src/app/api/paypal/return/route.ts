import { redirect } from "next/navigation";
import { readSessionId } from "@/lib/session";
import { friendlyError } from "@/lib/store";
import { cancelPayPalPayment, completePayPalPayment } from "@/lib/paypal";
import { clearPendingCheckout } from "@/lib/assistant/checkout";

// PayPal sends the shopper here after they approve the payment, with
// ?token=<PayPal order id>. The payment is captured and the order placed here.
export async function GET(request: Request) {
  const token = new URL(request.url).searchParams.get("token") ?? "";
  const sessionId = await readSessionId();
  if (!sessionId || !/^[A-Z0-9]{5,40}$/.test(token)) redirect("/?paypal=failed");

  let target: string;
  try {
    const { orderId, placedVia, returnPath } = await completePayPalPayment(sessionId, token);
    clearPendingCheckout(sessionId);
    // A chat order goes back to where the shopper was, and the chat shows the receipt.
    target =
      placedVia === "assistant"
        ? `${returnPath}${returnPath.includes("?") ? "&" : "?"}paypal=paid&order=${encodeURIComponent(orderId)}`
        : `/orders/${orderId}?placed=1`;
  } catch (error) {
    console.error("PayPal return failed:", friendlyError(error));
    const back = cancelPayPalPayment(sessionId, token);
    target = `${back}${back.includes("?") ? "&" : "?"}paypal=failed`;
  }
  // redirect() works by throwing, so it stays outside the try block.
  redirect(target);
}
