import { redirect } from "next/navigation";
import { readSessionId } from "@/lib/session";
import { cancelPayPalPayment } from "@/lib/paypal";

// The shopper clicked "Cancel and return" on PayPal: nothing was charged.
export async function GET(request: Request) {
  const token = new URL(request.url).searchParams.get("token") ?? "";
  const sessionId = await readSessionId();
  const back = sessionId && /^[A-Z0-9]{5,40}$/.test(token) ? cancelPayPalPayment(sessionId, token) : "/";
  redirect(`${back}${back.includes("?") ? "&" : "?"}paypal=cancelled`);
}
