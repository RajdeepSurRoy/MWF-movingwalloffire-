import type { Response } from "express";

/**
 * Everything the UI shows arrives as one of these events over a single
 * Server-Sent Events stream: chat messages, the agent's status, each browser
 * step it takes, and screenshots of its browser.
 */
export type AgentEvent =
  | { type: "message"; message: ChatMessage }
  | { type: "status"; state: AgentState; label: string }
  | { type: "step"; step: Step }
  | { type: "frame"; url: string; image: string }
  | { type: "cart"; itemCount: number; total: string }
  | { type: "usage"; usage: unknown }
  | { type: "wallet"; wallet: unknown }
  | { type: "reset" };

export type AgentState = "idle" | "thinking" | "browsing" | "awaiting_approval" | "paying" | "error";

export type ProductCard = {
  sku: string;
  name: string;
  brand: string;
  unit: string;
  price: string;
  soldOut: boolean;
  url: string;
  reason?: string;
};

export type PaymentRequest = {
  id: string;
  merchant: string;
  lines: { name: string; quantity: number; total: string }[];
  subtotal: string;
  delivery: string;
  total: string;
  totalCents: number;
  deliverTo: { name: string; email: string; address: string; deliverySlot: string };
  method: string;
  status: "pending" | "approved" | "declined" | "failed";
  /** Set when the firewall held this payment for the user to check. */
  warning?: string;
};

export type OrderReceipt = {
  orderId: string;
  merchant: string;
  total: string;
  deliverySlot: string;
  url: string;
  payment: string;
  /** PayPal's order id when the wallet paid on PayPal. */
  paypalOrderId?: string;
};

export type ChatMessage = {
  id: string;
  role: "user" | "agent" | "system";
  text: string;
  products?: ProductCard[];
  payment?: PaymentRequest;
  order?: OrderReceipt;
  at: number;
};

export type Step = {
  id: string;
  kind: "navigate" | "read" | "click" | "type" | "select" | "tool" | "think" | "pay" | "guard" | "error";
  label: string;
  detail?: string;
  status: "running" | "done" | "failed";
  at: number;
};

const clients = new Set<Response>();
/** Recent events, replayed to a browser tab that connects or reloads mid-session. */
let history: AgentEvent[] = [];
let lastFrame: AgentEvent | undefined;
const HISTORY_MAX = 400;

export function subscribe(res: Response) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
  for (const event of history) res.write(`data: ${JSON.stringify(event)}\n\n`);
  if (lastFrame) res.write(`data: ${JSON.stringify(lastFrame)}\n\n`);
  clients.add(res);
  const ping = setInterval(() => res.write(": ping\n\n"), 20_000);
  res.on("close", () => {
    clearInterval(ping);
    clients.delete(res);
  });
}

export function emit(event: AgentEvent) {
  if (event.type === "reset") history = [];
  // Frames are large and only the latest matters, so they aren't kept in history.
  if (event.type === "frame") lastFrame = event;
  else {
    history.push(event);
    if (history.length > HISTORY_MAX) history = history.slice(-HISTORY_MAX);
  }
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) res.write(data);
}

export const newId = () => Math.random().toString(36).slice(2, 10);

export function say(message: Omit<ChatMessage, "id" | "at">): ChatMessage {
  const full = { ...message, id: newId(), at: Date.now() };
  emit({ type: "message", message: full });
  return full;
}

export function setStatus(state: AgentState, label: string) {
  emit({ type: "status", state, label });
}

/** Records a step in the activity log. Call the returned function when it ends. */
export function step(kind: Step["kind"], label: string, detail?: string) {
  const s: Step = { id: newId(), kind, label, detail, status: "running", at: Date.now() };
  emit({ type: "step", step: s });
  return (status: Step["status"] = "done", newDetail?: string) => {
    emit({ type: "step", step: { ...s, status, detail: newDetail ?? s.detail } });
  };
}
