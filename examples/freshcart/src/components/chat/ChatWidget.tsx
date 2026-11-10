"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { OPEN_CHAT_EVENT } from "@/components/OpenChatButton";
import { ProductArt } from "@/components/ProductArt";
import { addToCartAction } from "@/app/actions/cart";
import { buyNowAction, placedOrderAction } from "@/app/actions/assistant";
import { formatPrice } from "@/lib/pricing";
import { stripMarkers } from "@/lib/chat-text";
import type { ProductCardData } from "@/lib/assistant/tools";
import type { CheckoutCardData, PlacedOrder } from "@/lib/assistant/checkout";

type CheckoutState = CheckoutCardData & { status?: "placed" | "replaced" };

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  products?: ProductCardData[];
  checkout?: CheckoutState;
  order?: PlacedOrder;
  paypal?: PayPalHandoff;
  error?: boolean;
};

type PayPalHandoff = { approveUrl: string; amountCents: number };

type ChatResponse = {
  reply?: string;
  error?: string;
  retryAfter?: number;
  products?: ProductCardData[];
  checkout?: CheckoutCardData;
  order?: PlacedOrder;
  paypal?: PayPalHandoff;
  cartChanged?: boolean;
};

type NewAssistantMessage = Omit<ChatMessage, "id" | "role">;

const STORAGE_KEY = "freshcart-chat-v2";
const PAYPAL_RETURN_MESSAGES: Record<string, string> = {
  cancelled: "You cancelled the PayPal payment, so nothing was charged. Your checkout is still here: say yes to try again, or tell me another way to pay.",
  failed: "PayPal couldn't complete that payment, so nothing was ordered. Say yes to try again, or tell me another way to pay.",
};
// How long the "Opening PayPal" message shows before the page goes to PayPal.
const PAYPAL_OPEN_DELAY_MS = 1500;

const SUGGESTIONS = ["Plan a pasta night for 4", "Suggest a healthy breakfast", "Snacks under $5", "Check out my cart"];

function loadSavedMessages(): ChatMessage[] {
  if (typeof window === "undefined") return [];
  try {
    const saved = sessionStorage.getItem(STORAGE_KEY);
    return saved ? JSON.parse(saved) : [];
  } catch {
    return [];
  }
}

function newId() {
  return Math.random().toString(36).slice(2, 10);
}

export function ChatWidget() {
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  // Restore the conversation for this tab (it survives page reloads). The
  // panel starts closed, so server and client render the same markup.
  const [messages, setMessages] = useState<ChatMessage[]>(loadSavedMessages);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  // After a "free plan limit" reply, sending pauses until the limit resets.
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(messages.slice(-40)));
    } catch {
      /* ignore */
    }
  }, [messages]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, sending]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (cooldownUntil <= now) return;
    const timer = setTimeout(() => setNow(Date.now()), 1000);
    return () => clearTimeout(timer);
  }, [cooldownUntil, now]);
  const cooldown = Math.max(0, Math.ceil((cooldownUntil - now) / 1000));

  /** Adds an assistant message. A new checkout or an order closes older checkout cards. */
  const addAssistant = useCallback((message: NewAssistantMessage) => {
    const closes = message.order ? ("placed" as const) : message.checkout ? ("replaced" as const) : undefined;
    setMessages((list) => [
      ...list.map((m) => (closes && m.checkout && !m.checkout.status ? { ...m, checkout: { ...m.checkout, status: closes } } : m)),
      { id: newId(), role: "assistant", ...message },
    ]);
  }, []);

  const send = useCallback(
    async (text: string) => {
      const content = text.trim();
      if (!content || sending || Date.now() < cooldownUntil) return;
      const userMessage: ChatMessage = { id: newId(), role: "user", content };
      const history = [...messages.filter((m) => !m.error), userMessage];
      setMessages((m) => [...m, userMessage]);
      setInput("");
      setSending(true);
      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: history.slice(-20).map(({ role, content }) => ({ role, content })), page: pathname }),
        });
        const data: ChatResponse = await res.json().catch(() => ({ error: "The assistant sent an unreadable reply." }));
        if (data.cartChanged) router.refresh();
        if (data.retryAfter) {
          setCooldownUntil(Date.now() + data.retryAfter * 1000);
          setNow(Date.now());
        }
        addAssistant(
          data.reply
            ? { content: data.reply, products: data.products, checkout: data.checkout, order: data.order, paypal: data.paypal }
            : { content: data.error ?? "Something went wrong. Please try again.", error: true, checkout: data.checkout, order: data.order },
        );
        // First PayPal payment: the shopper said yes, so open PayPal for them.
        const approveUrl = data.paypal?.approveUrl;
        if (approveUrl) setTimeout(() => window.location.assign(approveUrl), PAYPAL_OPEN_DELAY_MS);
      } catch {
        addAssistant({ content: "I couldn't reach the store. Check your connection and try again.", error: true });
      } finally {
        setSending(false);
      }
    },
    [messages, sending, cooldownUntil, router, pathname, addAssistant],
  );

  // Coming back from PayPal (?paypal=paid|cancelled|failed): say so in the
  // chat. The checkout page shows its own notice instead.
  useEffect(() => {
    const url = new URL(window.location.href);
    const status = url.searchParams.get("paypal");
    if (!status) return;
    const orderId = url.searchParams.get("order");
    url.searchParams.delete("paypal");
    url.searchParams.delete("order");
    window.history.replaceState(null, "", url.pathname + url.search + url.hash);
    if (status === "paid" && orderId) {
      let active = true;
      void placedOrderAction(orderId).then((placed) => {
        if (!active || !placed) return;
        setOpen(true);
        router.refresh();
        addAssistant({ content: placed.reply, order: placed.order });
      });
      return () => {
        active = false;
      };
    }
    const text = PAYPAL_RETURN_MESSAGES[status];
    if (!text || url.pathname === "/checkout") return;
    // Deferred so the state updates happen outside the effect body.
    const timer = setTimeout(() => {
      setOpen(true);
      addAssistant({ content: text, error: status === "failed" });
    }, 0);
    return () => clearTimeout(timer);
  }, [addAssistant, router]);

  // Other parts of the page can open the chat, optionally with a prompt.
  useEffect(() => {
    function onOpen(event: Event) {
      setOpen(true);
      const prompt = (event as CustomEvent<{ prompt?: string }>).detail?.prompt;
      if (prompt) void send(prompt);
    }
    window.addEventListener(OPEN_CHAT_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_CHAT_EVENT, onOpen);
  }, [send]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    if (open) window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="fixed bottom-5 right-5 z-40 flex items-center gap-2.5 rounded-full bg-ink py-3 pl-4 pr-5 text-sm font-medium text-white shadow-lg shadow-ink/20 transition-transform hover:-translate-y-0.5"
      >
        <ChatIcon />
        Ask FreshCart
      </button>
    );
  }

  return (
    <section
      aria-label="Shopping assistant"
      className="fixed inset-0 z-50 flex flex-col bg-paper sm:inset-auto sm:bottom-5 sm:right-5 sm:h-[min(640px,calc(100vh-2.5rem))] sm:w-[400px] sm:rounded-2xl sm:border sm:border-line sm:shadow-2xl sm:shadow-ink/15"
    >
      <header className="flex items-center gap-3 border-b border-line px-4 py-3">
        <span className="flex h-9 w-9 items-center justify-center rounded-full bg-green text-white">
          <ChatIcon />
        </span>
        <div className="flex-1">
          <h2 className="font-serif text-lg font-semibold leading-tight">Shopping assistant</h2>
          <p className="text-xs text-muted">Suggests items, fills your cart, orders for you</p>
        </div>
        {messages.length > 0 && (
          <button type="button" onClick={() => setMessages([])} className="rounded-md px-2 py-1 text-xs text-muted hover:bg-line/60 hover:text-ink">
            New chat
          </button>
        )}
        <button type="button" onClick={() => setOpen(false)} className="rounded-md p-1.5 text-muted hover:bg-line/60 hover:text-ink" aria-label="Close assistant">
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M6 6l12 12M18 6 6 18" strokeLinecap="round" />
          </svg>
        </button>
      </header>

      <div ref={listRef} className="flex-1 space-y-4 overflow-y-auto px-4 py-4" aria-live="polite">
        {messages.length === 0 && (
          <div className="pt-2">
            <p className="font-serif text-xl font-semibold">Hi! What are we shopping for?</p>
            <p className="mt-1.5 text-sm text-muted">
              Tell me what you need in your own words. I can suggest products, fill your cart, and place and pay for your order
              once you say yes. On a product page, just say &ldquo;buy this&rdquo;.
            </p>
            <div className="mt-5 flex flex-wrap gap-2">
              {SUGGESTIONS.map((s) => (
                <button key={s} type="button" onClick={() => send(s)} className="rounded-full border border-line bg-surface px-3.5 py-1.5 text-sm hover:border-green hover:text-green">
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m) => (
          <MessageView key={m.id} message={m} onAssistant={addAssistant} />
        ))}

        {sending && (
          <div className="flex gap-1 px-1 py-2" aria-label="Assistant is typing">
            {[0, 1, 2].map((i) => (
              <span key={i} className="typing-dot h-2 w-2 rounded-full bg-muted" style={{ animationDelay: `${i * 0.15}s` }} />
            ))}
          </div>
        )}
      </div>

      <form
        className="flex items-end gap-2 border-t border-line p-3"
        onSubmit={(e) => {
          e.preventDefault();
          void send(input);
        }}
      >
        <label htmlFor="chat-input" className="sr-only">Message the assistant</label>
        <textarea
          id="chat-input"
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send(input);
            }
          }}
          rows={1}
          maxLength={2000}
          placeholder={cooldown ? `Free plan limit: try again in ${cooldown}s` : "e.g. Add milk, eggs and a loaf of bread"}
          className="max-h-32 min-h-11 flex-1 resize-none rounded-xl border border-line bg-surface px-3.5 py-2.5 text-sm focus:border-green focus:outline-none"
        />
        <button
          type="submit"
          disabled={sending || !input.trim() || cooldown > 0}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-green text-white disabled:opacity-40"
          aria-label="Send"
        >
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M5 12h14M13 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </form>
    </section>
  );
}

type Handlers = {
  onAssistant: (message: NewAssistantMessage) => void;
};

function MessageView({ message, onAssistant }: { message: ChatMessage } & Handlers) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <p className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-green px-3.5 py-2.5 text-sm text-white">{message.content}</p>
      </div>
    );
  }
  return (
    <div className="space-y-2.5">
      <p
        className={`max-w-[92%] whitespace-pre-wrap rounded-2xl rounded-bl-md border px-3.5 py-2.5 text-sm leading-relaxed ${
          message.error ? "border-tomato/30 bg-tomato/5 text-tomato" : "border-line bg-surface"
        }`}
      >
        {stripMarkers(message.content)}
      </p>
      {message.order && <OrderCard order={message.order} />}
      {message.paypal && (
        <p className="text-xs text-muted">
          Opening PayPal for {formatPrice(message.paypal.amountCents)}…{" "}
          <a href={message.paypal.approveUrl} className="text-green underline">
            Open it yourself
          </a>{" "}
          if nothing happens.
        </p>
      )}
      {message.checkout && <CheckoutCard checkout={message.checkout} />}
      {message.products && message.products.length > 0 && (
        <ul className="-mx-4 flex gap-3 overflow-x-auto px-4 pb-1">
          {message.products.map((p) => (
            <ChatProductCard key={p.sku} product={p} onAssistant={onAssistant} />
          ))}
        </ul>
      )}
    </div>
  );
}

function OrderCard({ order }: { order: PlacedOrder }) {
  const paid = order.paymentMethod !== "cash_on_delivery";
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl bg-green-soft px-4 py-3 text-sm">
      <div>
        <p className="font-medium text-green">{paid ? "Paid · order placed" : "Order placed"}</p>
        <p className="font-mono text-xs">
          {order.id} · {formatPrice(order.totalCents)} · {order.paymentMethod === "card" ? "demo card" : order.paymentMethod === "paypal" ? "PayPal sandbox" : "pay on delivery"}
        </p>
      </div>
      <Link href={`/orders/${order.id}`} className="rounded-full bg-green px-3.5 py-1.5 text-xs font-medium text-white">
        View order
      </Link>
    </div>
  );
}

const MISSING_LABELS: Record<CheckoutCardData["missing"][number], string> = {
  name: "full name",
  email: "email",
  address: "delivery address",
  deliverySlot: "delivery time",
};

/**
 * The order summary the assistant asks the shopper to confirm. There is no Pay
 * button: the shopper says yes in the chat and the assistant places the order.
 */
function CheckoutCard({ checkout }: { checkout: CheckoutState }) {
  const done = checkout.status;
  const { details } = checkout;
  const payment =
    checkout.paymentMethod === "card"
      ? "Demo card · nothing is charged"
      : checkout.paymentMethod === "cash_on_delivery"
        ? "Pay on delivery"
        : checkout.paypalLinked
          ? `PayPal · ${checkout.paypalLinked}`
          : "PayPal sandbox · approve once on PayPal";

  return (
    <div className={`rounded-xl border border-line bg-surface p-3.5 text-sm ${done ? "opacity-60" : ""}`}>
      <div className="flex items-baseline justify-between">
        <p className="font-medium">{checkout.source === "buy_now" ? "Order summary" : "Order summary · your cart"}</p>
        {done && <span className="text-xs text-muted">{done === "placed" ? "Ordered" : "Replaced"}</span>}
      </div>
      <ul className="mt-2 space-y-1 text-xs">
        {checkout.items.map((i) => (
          <li key={i.sku} className="flex justify-between gap-2">
            <span className="truncate">
              {i.quantity} × {i.name}
            </span>
            <span className="tabular-nums">{formatPrice(i.lineTotalCents)}</span>
          </li>
        ))}
        <li className="flex justify-between text-muted">
          <span>Delivery</span>
          <span className="tabular-nums">{checkout.totals.deliveryCents ? formatPrice(checkout.totals.deliveryCents) : "Free"}</span>
        </li>
        <li className="flex justify-between border-t border-line pt-1 font-semibold">
          <span>Total</span>
          <span className="tabular-nums">{formatPrice(checkout.totals.totalCents)}</span>
        </li>
      </ul>

      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted">Deliver to</dt>
        <dd>{details.name && details.address ? `${details.name} · ${details.address}` : <Missing />}</dd>
        <dt className="text-muted">When</dt>
        <dd>{details.deliverySlot ?? <Missing />}</dd>
        <dt className="text-muted">Payment</dt>
        <dd>{payment}</dd>
      </dl>

      {!done && (
        <p className="mt-3 rounded-lg bg-green-soft px-3 py-2 text-xs text-green">
          {checkout.missing.length
            ? `Tell me your ${checkout.missing.map((f) => MISSING_LABELS[f]).join(", ")} to continue.`
            : "Reply “yes” and I'll place and pay for this order. Want something changed? Just tell me."}
        </p>
      )}
    </div>
  );
}

function Missing() {
  return <span className="text-tomato">needed</span>;
}

function ChatProductCard({ product, onAssistant }: { product: ProductCardData; onAssistant: Handlers["onAssistant"] }) {
  const [state, setState] = useState<"idle" | "adding" | "added" | "buying" | "error">("idle");
  async function add() {
    setState("adding");
    const result = await addToCartAction(product.sku, 1);
    setState(result.ok ? "added" : "error");
  }
  async function buy() {
    setState("buying");
    const result = await buyNowAction(product.sku, 1);
    setState("idle");
    onAssistant(result.ok ? { content: result.reply, checkout: result.checkout } : { content: result.error, error: true });
  }
  const busy = state === "adding" || state === "buying";
  return (
    <li className="w-36 shrink-0 rounded-xl border border-line bg-surface p-2">
      <Link href={`/p/${product.sku}`} className="block overflow-hidden rounded-lg">
        <ProductArt art={product.image} label={product.brand} title={product.name} />
      </Link>
      <p className="mt-2 line-clamp-2 text-xs font-medium leading-snug">{product.name}</p>
      <p className="text-[11px] text-muted">
        {product.unit} · <span className="font-semibold tabular-nums text-ink">{formatPrice(product.priceCents)}</span>
      </p>
      {product.stock > 0 ? (
        <div className="mt-1.5 flex gap-1.5">
          <button
            type="button"
            onClick={add}
            disabled={busy || state === "added"}
            className="flex-1 rounded-full border border-green py-0.5 text-[11px] font-medium text-green hover:bg-green-soft disabled:opacity-70"
            aria-label={`Add ${product.name} to cart`}
          >
            {state === "adding" ? "…" : state === "added" ? "Added" : state === "error" ? "Retry" : "Add"}
          </button>
          <button
            type="button"
            onClick={buy}
            disabled={busy}
            className="flex-1 rounded-full bg-green py-0.5 text-[11px] font-medium text-white hover:bg-green-dark disabled:opacity-70"
            aria-label={`Buy ${product.name} now`}
          >
            {state === "buying" ? "…" : "Buy"}
          </button>
        </div>
      ) : (
        <p className="mt-1.5 text-[11px] text-muted">Sold out</p>
      )}
    </li>
  );
}

function ChatIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v9a1.5 1.5 0 0 1-1.5 1.5H10l-4.5 4v-4h0A1.5 1.5 0 0 1 4 14.5z" strokeLinejoin="round" />
      <path d="M8.5 10h.01M12 10h.01M15.5 10h.01" strokeWidth="2.6" strokeLinecap="round" />
    </svg>
  );
}
