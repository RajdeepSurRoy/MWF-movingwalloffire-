import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { z } from "zod";
import { ensureSessionId, requestOrigin } from "@/lib/session";
import { PAYMENT_METHODS, friendlyError, getCart, getProduct, getSavedCustomer, listProducts, type PaymentMethod } from "@/lib/store";
import { buildSystemPrompt } from "@/lib/assistant/prompt";
import { RateLimitedError, complete, llmConfig } from "@/lib/assistant/llm";
import { currentCheckoutCard, linkedPayPal, placeCheckout, updateCheckout } from "@/lib/assistant/checkout";
import { forgetSavedPayPal, paypalEnabled } from "@/lib/paypal";
import { formatPrice } from "@/lib/pricing";
import { productsFromReply, skusInText } from "@/lib/assistant/markers";
import { canaryLine, guardCheckout, screenForModel, screenReply } from "@/lib/firewall";
import {
  TOOL_DEFINITIONS,
  card,
  checkoutReply,
  isActionTool,
  mergeEffects,
  orderReply,
  paypalReply,
  runTool,
  type ToolOutcome,
  type ToolEffects,
} from "@/lib/assistant/tools";

// Each round is one API request. Most turns need one; the cap stops a
// confused model from burning the free quota.
const MAX_TOOL_ROUNDS = 3;
// Only the latest turns are sent: the cart, checkout and catalog are in the
// system prompt, so older messages add tokens without adding much.
const HISTORY_LIMIT = 12;

const bodySchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().trim().min(1).max(2000),
      }),
    )
    .min(1)
    .max(40)
    .refine((m) => m[m.length - 1].role === "user", "The last message must be from the shopper."),
  page: z.string().max(200).optional(),
});

// Short confirmations are handled without asking the model.
const YES = /^(yes|yep|yeah|yup|sure|ok(ay)?|confirm(ed)?|go ahead|do it|place (it|the order)|pay( now)?|buy it)( please)?[\s.!]*$/i;
const BUY_THIS = /^(please )?(buy|order|purchase|get) (this|it)( now| for me)?( please)?[\s.!]*$/i;
const UNLINK_PAYPAL = /^(please )?(unlink|forget|remove|disconnect) (my )?pay ?pal( account)?( please)?[\s.!]*$/i;

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

/** The product page the shopper is on, from a path like /p/DRY-EGGS-12. */
function viewingProduct(page?: string) {
  const sku = page && /^\/p\/([A-Za-z0-9-]{3,40})$/.exec(page)?.[1];
  return sku ? getProduct(sku) : undefined;
}

/**
 * The shopper said yes: the assistant places and pays for the order itself.
 * The only case that leaves the chat is a first PayPal payment, which the
 * shopper approves once on PayPal (the widget opens it for them).
 */
async function placeOrderForShopper(sessionId: string, page: string | undefined, prompt: string, paymentMethod?: PaymentMethod): Promise<ToolOutcome> {
  try {
    const origin = await requestOrigin();
    await guardCheckout(sessionId, prompt, currentCheckoutCard(sessionId), origin);
    const result = await placeCheckout(sessionId, { paymentMethod, origin, returnPath: page ?? "/" });
    if ("paypal" in result) {
      return {
        output: { ok: true, note: "PayPal is opening for the shopper to approve once." },
        effects: { paypal: result.paypal },
        reply: paypalReply(result.paypal.amountCents),
      };
    }
    return {
      output: { ok: true, order_id: result.order.id, total: formatPrice(result.order.totalCents) },
      effects: { order: result.order, cartChanged: true },
      reply: orderReply(result.order),
    };
  } catch (error) {
    return { output: { error: friendlyError(error) }, effects: {} };
  }
}

function paymentArg(rawArgs: string): PaymentMethod | undefined {
  try {
    const method = (JSON.parse(rawArgs || "{}") as { payment_method?: unknown }).payment_method;
    return PAYMENT_METHODS.find((m) => m === method);
  } catch {
    return undefined;
  }
}

/** runTool, with the firewall around the two tools that matter: reading listings and ordering. */
async function runGuardedTool(sessionId: string, prompt: string, page: string | undefined, name: string, args: string): Promise<ToolOutcome> {
  if (name === "confirm_order") return placeOrderForShopper(sessionId, page, prompt, paymentArg(args));
  try {
    const outcome = runTool(sessionId, name, args);
    if (name === "get_product") return { ...outcome, output: await screenForModel(sessionId, prompt, outcome.output) };
    return outcome;
  } catch (error) {
    return { output: { error: friendlyError(error) }, effects: {} };
  }
}

export async function POST(request: Request) {
  if (!llmConfig().apiKey) {
    return json({ error: "The assistant isn't set up yet. Add GEMINI_API_KEY to .env.local and restart the server." }, 503);
  }

  let body: z.infer<typeof bodySchema>;
  try {
    const parsed = bodySchema.safeParse(await request.json());
    if (!parsed.success) return json({ error: parsed.error.issues[0]?.message ?? "Invalid request." }, 400);
    body = parsed.data;
  } catch {
    return json({ error: "Request body must be JSON." }, 400);
  }

  const sessionId = await ensureSessionId();
  const latest = body.messages[body.messages.length - 1].content;
  const viewing = viewingProduct(body.page);

  // ---- Shortcuts that need no API call ----
  try {
    const pending = currentCheckoutCard(sessionId);
    if (pending && pending.missing.length === 0 && YES.test(latest)) {
      const outcome = await placeOrderForShopper(sessionId, body.page, latest);
      return json(outcome.reply ? { reply: outcome.reply, ...outcome.effects } : { reply: (outcome.output as { error: string }).error });
    }
    if (UNLINK_PAYPAL.test(latest)) {
      return json({
        reply: forgetSavedPayPal(sessionId)
          ? "Done, your PayPal account is unlinked. Next time you pay with PayPal, you'll approve it on PayPal again."
          : "There's no PayPal account linked right now.",
      });
    }
    if (BUY_THIS.test(latest)) {
      const lastAssistant = body.messages.findLast((m) => m.role === "assistant");
      const shown = lastAssistant ? skusInText(lastAssistant.content) : [];
      const target = viewing ?? (shown.length === 1 ? getProduct(shown[0]) : undefined);
      if (target) {
        const checkout = updateCheckout(sessionId, { items: [{ sku: target.sku, quantity: 1 }] });
        return json({ reply: checkoutReply(checkout), checkout });
      }
    }
  } catch (error) {
    return json({ reply: friendlyError(error) });
  }

  // ---- The model ----
  let canary: string;
  try {
    canary = await canaryLine(sessionId, latest);
  } catch (error) {
    return json({ reply: friendlyError(error) });
  }
  const cart = getCart(sessionId);
  const messages: ChatCompletionMessageParam[] = [
    {
      role: "system",
      content: buildSystemPrompt({
        catalog: listProducts({ limit: 60 }),
        cart,
        checkout: currentCheckoutCard(sessionId),
        viewing,
        hasSavedDetails: Boolean(getSavedCustomer(sessionId)),
        paypalEnabled: paypalEnabled(),
        paypalLinked: linkedPayPal(sessionId),
      }) + canary,
    },
    ...body.messages.slice(-HISTORY_LIMIT),
  ];

  let effects: ToolEffects = {};
  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const { message } = await complete(messages, TOOL_DEFINITIONS);
      const toolCalls = (message.tool_calls ?? []).filter((c) => c.type === "function");

      if (toolCalls.length === 0) {
        const reply = await screenReply(sessionId, latest, message.content?.trim() || "Sorry, I didn't catch that. Could you rephrase?");
        const products = productsFromReply(reply).map(card);
        return json({ reply, ...effects, products: products.length ? products : effects.products });
      }

      // Keep the assistant message as the API sent it: Gemini 3 needs its
      // "thought signature" back on tool-call turns.
      messages.push({ role: "assistant", content: message.content ?? null, tool_calls: toolCalls });
      const replies: string[] = [];
      let allHandled = true;
      for (const call of toolCalls) {
        const outcome = await runGuardedTool(sessionId, latest, body.page, call.function.name, call.function.arguments);
        effects = mergeEffects(effects, outcome.effects);
        if (outcome.reply && isActionTool(call.function.name)) replies.push(outcome.reply);
        else allHandled = false;
        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(outcome.output) });
      }

      // Successful actions describe themselves: skip the follow-up request.
      if (allHandled) return json({ reply: replies.at(-1), ...effects });
    }
    return json({ reply: "That took more steps than expected. Could you try asking in a simpler way?", ...effects });
  } catch (error) {
    if (error instanceof RateLimitedError) {
      return json(
        {
          error: `I'm getting a lot of questions right now (free plan limit). Please try again in about ${error.retryAfter} seconds.`,
          retryAfter: error.retryAfter,
          ...effects,
        },
        429,
      );
    }
    if (error instanceof OpenAI.APIError) {
      console.error("Gemini error", error.status, error.message);
      const reply =
        error.status === 400 && /api key/i.test(error.message)
          ? "The assistant's API key was rejected. Check GEMINI_API_KEY in .env.local."
          : error.status === 401 || error.status === 403
            ? "The assistant's API key was rejected. Check GEMINI_API_KEY in .env.local."
            : error.status === 404
              ? `The model "${llmConfig().model}" isn't available for this API key. Set GEMINI_MODEL in .env.local.`
              : "The assistant ran into a problem. Please try again.";
      // Cart changes made before the failure still happened, so tell the widget.
      return json({ error: reply, ...effects }, 502);
    }
    console.error(error);
    return json({ error: "The assistant ran into a problem. Please try again.", ...effects }, 500);
  }
}
