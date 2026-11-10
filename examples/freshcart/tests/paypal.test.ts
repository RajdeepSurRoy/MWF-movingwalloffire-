import { beforeEach, describe, expect, it } from "vitest";
import type { DB } from "../src/lib/db";
import { StoreError, addToCart, getCart, getProduct, listOrders, placeOrder } from "../src/lib/store";
import {
  PayPalRequestError,
  cancelPayPalPayment,
  completePayPalPayment,
  getSavedPayPal,
  startPayPalPayment,
  type PayPalApi,
} from "../src/lib/paypal";
import { clearPendingCheckout, getPendingCheckout, placeCheckout, startCheckoutPayPal, updateCheckout } from "../src/lib/assistant/checkout";
import { paypalPayments } from "../src/lib/db/schema";
import { freshDb } from "./helpers";

const SID = "44444444-4444-4444-8444-444444444444";
const OTHER = "55555555-5555-4555-8555-555555555555";
const details = { name: "Pat Payer", email: "pat@example.com", address: "7 Sandbox Road, Testville", deliverySlot: "Today, 5–7 pm" };

/** A stand-in for PayPal that records what it was asked and captures whatever amount it was created with. */
function fakePayPal(
  overrides: Partial<{ captureValue: string; captureStatus: string; saveAccount: boolean; savedChargeValue: string; declineSaved: boolean }> = {},
) {
  const created: { amountCents: number; returnUrl: string; cancelUrl: string }[] = [];
  const captured: string[] = [];
  const charged: { amountCents: number; vaultId: string }[] = [];
  let counter = 0;
  const api: PayPalApi = {
    async createOrder(input) {
      created.push(input);
      counter += 1;
      return { id: `PAYPALORDER${counter}`, approveUrl: `https://www.sandbox.paypal.com/checkoutnow?token=PAYPALORDER${counter}` };
    },
    async getOrder(id) {
      const order = created[Number(id.replace("PAYPALORDER", "")) - 1];
      return { id, status: "APPROVED", amountValue: (order.amountCents / 100).toFixed(2), currency: "USD", payeeEmail: "shop@business.example.com" };
    },
    async captureOrder(id) {
      captured.push(id);
      const order = created[Number(id.replace("PAYPALORDER", "")) - 1];
      return {
        status: overrides.captureStatus ?? "COMPLETED",
        captureId: `CAPTURE-${id}`,
        amountValue: overrides.captureValue ?? (order.amountCents / 100).toFixed(2),
        currency: "USD",
        vault: overrides.saveAccount ? { id: "VAULT-1", customerId: "CUST-1", email: "buyer@personal.example.com" } : undefined,
      };
    },
    async chargeSaved({ amountCents, vaultId }) {
      if (overrides.declineSaved) throw new PayPalRequestError("declined", 422, "INSTRUMENT_DECLINED");
      charged.push({ amountCents, vaultId });
      return {
        id: `SAVEDORDER${charged.length}`,
        status: "COMPLETED",
        captureId: `SAVEDCAPTURE${charged.length}`,
        amountValue: overrides.savedChargeValue ?? (amountCents / 100).toFixed(2),
        currency: "USD",
      };
    },
  };
  return { api, created, charged, captured };
}

/** Links a PayPal account the way a shopper does: one payment approved on PayPal. */
async function linkPayPal() {
  const { api } = fakePayPal({ saveAccount: true });
  await start(api);
  await completePayPalPayment(SID, "PAYPALORDER1", db, api);
}

// The fake API below stands in for PayPal; these only make the store treat PayPal as set up.
process.env.PAYPAL_CLIENT_ID ??= "test-client";
process.env.PAYPAL_CLIENT_SECRET ??= "test-secret";

let db: DB;
beforeEach(() => {
  db = freshDb();
  clearPendingCheckout(SID);
});

const start = (api: PayPalApi, sessionId = SID) =>
  startPayPalPayment(
    sessionId,
    { items: [{ sku: "PNT-OLIVE-500", quantity: 2 }], fromCart: false, details, placedVia: "web", origin: "http://localhost:3000", returnPath: "/checkout" },
    db,
    api,
  );

describe("PayPal sandbox payments", () => {
  it("charges the database total and places a paid order after capture", async () => {
    const { api, created } = fakePayPal();
    const { approveUrl } = await start(api);
    expect(approveUrl).toContain("sandbox.paypal.com");
    expect(created[0].amountCents).toBe(2 * 1299 + 499);
    expect(created[0].returnUrl).toBe("http://localhost:3000/api/paypal/return");

    const stock = getProduct("PNT-OLIVE-500", db)!.stock;
    const { orderId } = await completePayPalPayment(SID, "PAYPALORDER1", db, api);
    const order = listOrders(SID, db)[0];
    expect(order.id).toBe(orderId);
    expect(order.paymentMethod).toBe("paypal");
    expect(order.paymentStatus).toBe("paid");
    expect(order.paymentRef).toBe("CAPTURE-PAYPALORDER1");
    expect(getProduct("PNT-OLIVE-500", db)!.stock).toBe(stock - 2);
  });

  it("shows the guard what PayPal holds before capturing, and reports the capture id after", async () => {
    const { api, captured } = fakePayPal();
    await start(api);
    const seen: unknown[] = [];
    const recorded: string[] = [];
    await completePayPalPayment(SID, "PAYPALORDER1", db, api, async (input) => {
      seen.push(input);
      expect(captured).toEqual([]); // nothing taken yet
      return async (captureId) => void recorded.push(captureId);
    });
    expect(seen).toEqual([
      {
        sessionId: SID,
        held: { id: "PAYPALORDER1", status: "APPROVED", amountValue: "30.97", currency: "USD", payeeEmail: "shop@business.example.com" },
        items: [{ sku: "PNT-OLIVE-500", quantity: 2 }],
        amountCents: 2 * 1299 + 499,
      },
    ]);
    expect(captured).toEqual(["PAYPALORDER1"]);
    expect(recorded).toEqual(["CAPTURE-PAYPALORDER1"]);
  });

  it("captures nothing and places no order when the guard refuses", async () => {
    const { api, captured } = fakePayPal();
    await start(api);
    const refuse = async () => {
      throw new StoreError("The store's payment check stopped this payment before it was taken (BLOCK: COMMIT.EFFECT_PAYEE_MISMATCH).");
    };
    await expect(completePayPalPayment(SID, "PAYPALORDER1", db, api, refuse)).rejects.toThrow(/EFFECT_PAYEE_MISMATCH/);
    expect(captured).toEqual([]);
    expect(listOrders(SID, db)).toHaveLength(0);
    expect(db.select().from(paypalPayments).get()?.status).toBe("failed");
  });

  it("returns the same order when the return page is loaded twice", async () => {
    const { api } = fakePayPal();
    await start(api);
    const first = await completePayPalPayment(SID, "PAYPALORDER1", db, api);
    const second = await completePayPalPayment(SID, "PAYPALORDER1", db, api);
    expect(second.orderId).toBe(first.orderId);
    expect(listOrders(SID, db)).toHaveLength(1);
  });

  it("refuses to place the order when the captured amount doesn't match", async () => {
    const { api } = fakePayPal({ captureValue: "0.01" });
    await start(api);
    await expect(completePayPalPayment(SID, "PAYPALORDER1", db, api)).rejects.toThrow(/doesn't match/);
    expect(listOrders(SID, db)).toHaveLength(0);
  });

  it("refuses an incomplete capture", async () => {
    const { api } = fakePayPal({ captureStatus: "PENDING" });
    await start(api);
    await expect(completePayPalPayment(SID, "PAYPALORDER1", db, api)).rejects.toThrow(/didn't complete/);
  });

  it("won't let another session complete someone else's payment", async () => {
    const { api } = fakePayPal();
    await start(api);
    await expect(completePayPalPayment(OTHER, "PAYPALORDER1", db, api)).rejects.toThrow(/couldn't find/);
  });

  it("cancels without ordering and remembers where to send the shopper", async () => {
    const { api } = fakePayPal();
    await start(api);
    expect(cancelPayPalPayment(SID, "PAYPALORDER1", db)).toBe("/checkout");
    await expect(completePayPalPayment(SID, "PAYPALORDER1", db, api)).rejects.toThrow(/already handled/);
    expect(listOrders(SID, db)).toHaveLength(0);
  });

  it("won't place a PayPal order without a captured payment", () => {
    addToCart(SID, "DRY-EGGS-12", 1, db);
    expect(() => placeOrder(SID, details, "web", db, { paymentMethod: "paypal" })).toThrow(/PayPal/);
  });

  it("pays for a chat cart checkout with the cart frozen at the time of payment", async () => {
    const { api, created } = fakePayPal();
    addToCart(SID, "DRY-EGGS-12", 2, db);
    updateCheckout(SID, { useCart: true, ...details }, db);
    await startCheckoutPayPal(SID, { origin: "http://localhost:3000", returnPath: "/" }, db, api);
    expect(created[0].amountCents).toBe(2 * 549 + 499);
    expect(getPendingCheckout(SID)?.paymentMethod).toBe("paypal");

    addToCart(SID, "BKY-SOUR-LOAF", 1, db); // changes after paying are not part of this order
    await completePayPalPayment(SID, "PAYPALORDER1", db, api);
    expect(listOrders(SID, db)[0].items.map((i) => i.sku)).toEqual(["DRY-EGGS-12"]);
    expect(getCart(SID, db).lines.map((l) => l.sku)).toEqual(["BKY-SOUR-LOAF"]);
  });
});

describe("The assistant pays by itself after a yes", () => {
  const origin = { origin: "http://localhost:3000", returnPath: "/" };

  it("opens PayPal the first time, which links the account", async () => {
    const { api } = fakePayPal({ saveAccount: true });
    updateCheckout(SID, { items: [{ sku: "DRY-EGGS-12", quantity: 1 }], ...details, paymentMethod: "paypal" }, db);
    const result = await placeCheckout(SID, origin, db, api);
    expect("paypal" in result && result.paypal.approveUrl).toContain("sandbox.paypal.com");
    expect(getSavedPayPal(SID, db)).toBeUndefined();

    await completePayPalPayment(SID, "PAYPALORDER1", db, api);
    expect(getSavedPayPal(SID, db)?.vaultId).toBe("VAULT-1");
  });

  it("charges the linked PayPal account and places a paid order without leaving the chat", async () => {
    await linkPayPal();
    const { api, created, charged } = fakePayPal();
    const checkout = updateCheckout(SID, { items: [{ sku: "DRY-EGGS-12", quantity: 2 }], ...details }, db);
    expect(checkout.paymentMethod).toBe("paypal"); // the linked account is the default
    expect(checkout.paypalLinked).toBe("buyer@personal.example.com");

    const result = await placeCheckout(SID, origin, db, api);
    expect(created).toHaveLength(0); // no PayPal page
    expect(charged).toEqual([{ amountCents: 2 * 549 + 499, vaultId: "VAULT-1" }]);
    const order = listOrders(SID, db)[0];
    expect("order" in result && result.order.id).toBe(order.id);
    expect(order.paymentMethod).toBe("paypal");
    expect(order.paymentStatus).toBe("paid");
    expect(order.paymentRef).toBe("SAVEDCAPTURE1");
    expect(getPendingCheckout(SID)).toBeUndefined();
  });

  it("places no order when the charged amount doesn't match", async () => {
    await linkPayPal();
    const { api } = fakePayPal({ savedChargeValue: "0.01" });
    updateCheckout(SID, { items: [{ sku: "DRY-EGGS-12", quantity: 1 }], ...details }, db);
    await expect(placeCheckout(SID, origin, db, api)).rejects.toThrow(/doesn't match/);
    expect(listOrders(SID, db)).toHaveLength(1); // only the order that linked the account
    expect(db.select().from(paypalPayments).all().find((p) => p.paypalOrderId === "SAVEDORDER1")?.status).toBe("failed");
  });

  it("unlinks an account PayPal declines, and charges nothing", async () => {
    await linkPayPal();
    const { api } = fakePayPal({ declineSaved: true });
    updateCheckout(SID, { items: [{ sku: "DRY-EGGS-12", quantity: 1 }], ...details }, db);
    await expect(placeCheckout(SID, origin, db, api)).rejects.toThrow(/unlinked it/);
    expect(getSavedPayPal(SID, db)).toBeUndefined();
    expect(listOrders(SID, db)).toHaveLength(1);
  });

  it("places demo-card orders straight away", async () => {
    const { api } = fakePayPal();
    updateCheckout(SID, { items: [{ sku: "DRY-EGGS-12", quantity: 1 }], ...details, paymentMethod: "card" }, db);
    const result = await placeCheckout(SID, origin, db, api);
    expect("order" in result && result.order.paymentMethod).toBe("card");
    expect(listOrders(SID, db)[0].paymentStatus).toBe("paid");
  });
});
