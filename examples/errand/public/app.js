const $ = (id) => document.getElementById(id);
const messagesEl = $("messages");
const stepsEl = $("steps");
const input = $("input");
const sendBtn = $("send");
let state = "idle";
let info = null;

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// ---------- Talking to the server ----------

async function post(path, body, method = "POST") {
  const res = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

async function send(text) {
  text = text.trim();
  if (!text || isBusy()) return;
  input.value = "";
  autosize();
  try {
    await post("/api/chat", { text });
  } catch (error) {
    flash(error.message);
  }
}

function flash(text) {
  renderMessage({ id: "local-" + Date.now(), role: "agent", text, at: Date.now() });
}

// ---------- Live events ----------

function connect() {
  const source = new EventSource("/api/events");
  source.onmessage = (e) => handle(JSON.parse(e.data));
  source.onerror = () => setStatus("error", "Lost connection to the agent. Reconnecting…");
  source.onopen = () => {
    if (state === "error") setStatus("idle", "Ready");
  };
}

function handle(event) {
  switch (event.type) {
    case "reset":
      messagesEl.querySelectorAll(".msg").forEach((m) => m.remove());
      stepsEl.innerHTML = "";
      $("welcome").hidden = false;
      $("frame").hidden = true;
      $("screen-empty").hidden = false;
      $("url").textContent = "about:blank";
      updateStepCount();
      break;
    case "message":
      if (event.message.role === "system" && event.message.payment) updatePaymentCard(event.message.payment);
      else renderMessage(event.message);
      break;
    case "status":
      setStatus(event.state, event.label);
      break;
    case "step":
      renderStep(event.step);
      break;
    case "frame":
      $("frame").src = event.image;
      $("frame").hidden = false;
      $("screen-empty").hidden = true;
      $("url").textContent = event.url;
      break;
    case "wallet":
      renderWallet(event.wallet);
      break;
    case "usage":
      renderUsage(event.usage);
      break;
    case "cart": {
      const pill = $("cart-pill");
      const changed = $("cart-count").textContent !== String(event.itemCount);
      $("cart-count").textContent = event.itemCount;
      $("cart-total").textContent = event.total || "$0.00";
      if (changed) {
        pill.classList.remove("bump");
        void pill.offsetWidth;
        pill.classList.add("bump");
      }
      break;
    }
  }
}

// ---------- AI usage ----------

function renderUsage(u) {
  const pill = $("usage-pill");
  if (u.mode === "mock") {
    pill.innerHTML = "AI: <b>offline mock</b> · no quota used";
    pill.className = "pill usage";
    return;
  }
  const main = u.models[0];
  const sent = u.models.reduce((n, m) => n + m.calls, 0);
  const mainLeft = main.limit ? Math.max(0, main.limit - main.calls) : null;
  const allOut = u.models.every((m) => m.coolingUntil || (m.limit && m.calls >= m.limit));
  pill.innerHTML = `AI today: <b>${sent}</b> sent · <b>${u.saved}</b> saved`;
  pill.className = `pill usage${allOut ? " out" : main.coolingUntil || mainLeft === 0 ? " low" : ""}`;
  pill.title = [
    ...u.models.map((m) => {
      const state = m.coolingUntil ? ` (paused until ${new Date(m.coolingUntil).toLocaleTimeString()})` : "";
      return `${m.model}: ${m.calls}${m.limit ? ` of ${m.limit}` : ""} requests today${state}`;
    }),
    `${u.saved} requests saved (${u.cacheHits} from the answer cache, the rest by shortcuts)`,
    `Quota day: ${u.day} (resets at midnight Pacific time)`,
  ].join("\n");
}

// ---------- Wallet ----------

function renderWallet(w) {
  const pill = $("wallet-pill");
  if (!w.configured || w.mode === "off") {
    pill.innerHTML = `Wallet: <b>${w.mode === "off" ? "off" : "not set up"}</b>`;
    pill.className = "pill wallet low";
    pill.title = w.mode === "off"
      ? "WALLET_MODE=off: the agent uses the shop's own payment option"
      : "Add PAYPAL_BUYER_EMAIL and PAYPAL_BUYER_PASSWORD (a PayPal sandbox personal account) to .env";
    return;
  }
  pill.innerHTML = `PayPal wallet · <b>${esc(w.spentToday)}</b> today`;
  pill.className = "pill wallet";
  pill.title = [
    `PayPal sandbox account: ${w.account}`,
    `Mode: ${w.mode === "paypal" ? "PayPal only" : "PayPal when the shop offers it"}`,
    ...w.recent.map((e) =>
      `${new Date(e.at).toLocaleString()} · ${e.merchant} · ${e.amount} · ${e.status}${e.orderId ? ` · ${e.orderId}` : ""}`),
  ].join("\n");
}

// ---------- Status ----------

const isBusy = () => ["thinking", "browsing", "paying"].includes(state);

function setStatus(next, label) {
  state = next;
  $("status").dataset.state = next;
  $("status-label").textContent = next === "idle" ? "Ready" : label;
  $("live-badge").classList.toggle("on", next === "browsing" || next === "paying");
  sendBtn.disabled = isBusy();
  $("reset-btn").disabled = isBusy();
  document.querySelectorAll(".product .btn, .card .btn.approve").forEach((b) => (b.disabled = isBusy()));
}

// ---------- Chat messages ----------

function renderMessage(m) {
  if (document.getElementById("m-" + m.id)) return;
  $("welcome").hidden = true;
  const el = document.createElement("div");
  el.className = `msg ${m.role}`;
  el.id = "m-" + m.id;
  let html = m.role === "agent" ? `<span class="who">Errand</span>` : "";
  if (m.text) html += `<div class="bubble">${esc(m.text)}</div>`;
  if (m.products?.length) html += `<div class="products">${m.products.map(productHtml).join("")}</div>`;
  if (m.payment) html += paymentHtml(m.payment);
  if (m.order) html += orderHtml(m.order);
  el.innerHTML = html;
  messagesEl.appendChild(el);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function productHtml(p) {
  return `<div class="product">
    <span class="brand-line">${esc(p.brand)}</span>
    <span class="name"><a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.name)}</a></span>
    <span class="unit">${esc(p.unit)}</span>
    ${p.reason ? `<span class="reason">${esc(p.reason)}</span>` : ""}
    <div class="foot">
      <span class="price">${esc(p.price)}</span>
      ${p.soldOut ? `<span class="muted small">Sold out</span>` : `<button type="button" class="btn ghost" data-add="${esc(p.sku)}" ${isBusy() ? "disabled" : ""}>Add</button>`}
    </div>
  </div>`;
}

function paymentHtml(p) {
  const budget = info?.profile?.budgetPerOrder;
  const over = budget && p.totalCents > budget * 100;
  const paypal = /^PayPal/.test(p.method);
  return `<div class="card payment" data-payment="${esc(p.id)}">
    <div class="card-head"><h3>Confirm your order</h3><span class="badge ${esc(p.status)}">${statusLabel(p.status)}</span></div>
    <div class="meta"><span>Merchant: <b>${esc(p.merchant)}</b></span></div>
    <ul class="lines">${p.lines.map((l) => `<li><span>${l.quantity} × ${esc(l.name)}</span><span>${esc(l.total)}</span></li>`).join("")}</ul>
    <dl class="totals">
      <div><dt>Subtotal</dt><dd>${esc(p.subtotal)}</dd></div>
      <div><dt>Delivery</dt><dd>${esc(p.delivery)}</dd></div>
      <div class="grand"><dt>Total</dt><dd>${esc(p.total)}</dd></div>
    </dl>
    ${p.warning ? `<div class="warn">${esc(p.warning)}</div>` : ""}
    ${over ? `<div class="warn">Over your $${budget} budget per order.</div>` : ""}
    <div class="meta">
      <span>Deliver to: <b>${esc(p.deliverTo.name)}</b>, ${esc(p.deliverTo.address)}</span>
      <span>When: <b>${esc(p.deliverTo.deliverySlot)}</b></span>
      <span>Pay with: <b>${esc(p.method)}</b></span>
    </div>
    <div class="actions" ${p.status === "pending" ? "" : "hidden"}>
      <span class="muted small">${paypal
        ? "After you confirm, Errand pays on PayPal with its wallet and places the order. Nothing else to do."
        : `After you confirm, Errand places the order on ${esc(p.merchant)}.`}</span>
      <button type="button" class="btn ghost" data-decline="${esc(p.id)}">Decline</button>
      <button type="button" class="btn primary approve" data-approve="${esc(p.id)}">${paypal ? "Confirm & pay" : "Confirm"} ${esc(p.total)}</button>
    </div>
  </div>`;
}

const statusLabel = (s) => ({ pending: "Needs approval", approved: "Paid", declined: "Declined", failed: "Failed" })[s] ?? s;

function updatePaymentCard(p) {
  document.querySelectorAll(`[data-payment="${CSS.escape(p.id)}"]`).forEach((card) => {
    const badge = card.querySelector(".badge");
    badge.className = `badge ${p.status}`;
    badge.textContent = statusLabel(p.status);
    card.querySelector(".actions").hidden = p.status !== "pending";
  });
}

function orderHtml(o) {
  return `<div class="card order">
    <div class="card-head"><h3>Order placed</h3><span class="badge approved">Confirmed by ${esc(o.merchant)}</span></div>
    <span class="order-id">${esc(o.orderId)}</span>
    <dl class="totals">
      <div class="grand"><dt>Total</dt><dd>${esc(o.total)}</dd></div>
    </dl>
    <div class="meta">
      <span>Arrives: <b>${esc(o.deliverySlot)}</b></span>
      <span>Paid with: <b>${esc(o.payment)}</b></span>
      ${o.paypalOrderId ? `<span>PayPal order: <b>${esc(o.paypalOrderId)}</b></span>` : ""}
    </div>
    <span class="muted small">Placed by Errand in its own ${esc(o.merchant)} session.</span>
  </div>`;
}

messagesEl.addEventListener("click", async (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  try {
    if (btn.classList.contains("chip")) return send(btn.textContent);
    if (btn.dataset.add) {
      btn.disabled = true;
      await post("/api/cart/add", { sku: btn.dataset.add });
    } else if (btn.dataset.approve) {
      btn.closest(".actions").querySelectorAll("button").forEach((b) => (b.disabled = true));
      await post(`/api/payments/${btn.dataset.approve}/approve`);
    } else if (btn.dataset.decline) {
      await post(`/api/payments/${btn.dataset.decline}/decline`);
    }
  } catch (error) {
    btn.disabled = false;
    flash(error.message);
  }
});

// ---------- Activity log ----------

const ICONS = {
  navigate: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  read: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  click: '<path d="M9 9l11 4-5 2-2 5z"/><path d="M5 3v3M3 5h3"/>',
  type: '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 10h.01M11 10h.01M15 10h.01M8 14h8"/>',
  select: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/>',
  tool: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.5-.5-.5-2.5z"/>',
  think: '<path d="M12 3a6 6 0 0 0-4 10.5V17h8v-3.5A6 6 0 0 0 12 3zM9 21h6"/>',
  pay: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/>',
  error: '<path d="M12 8v5M12 16h.01"/><circle cx="12" cy="12" r="9"/>',
};

function renderStep(s) {
  let el = document.getElementById("s-" + s.id);
  if (!el) {
    el = document.createElement("li");
    el.id = "s-" + s.id;
    stepsEl.appendChild(el);
  }
  el.className = `${s.kind} ${s.status}`;
  el.innerHTML = `<span class="icon"><svg viewBox="0 0 24 24">${ICONS[s.kind] ?? ICONS.tool}</svg></span>
    <span class="text"><span class="label">${esc(s.label)}</span>${s.detail ? `<span class="detail">${esc(s.detail)}</span>` : ""}</span>
    <span class="state">${s.status === "done" ? "✓" : s.status === "failed" ? "failed" : ""}</span>`;
  stepsEl.scrollTop = stepsEl.scrollHeight;
  updateStepCount();
}

function updateStepCount() {
  const n = stepsEl.children.length;
  $("step-count").textContent = `${n} step${n === 1 ? "" : "s"}`;
}

// ---------- Composer ----------

function autosize() {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 140) + "px";
}
input.addEventListener("input", autosize);
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send(input.value);
  }
});
$("composer").addEventListener("submit", (e) => {
  e.preventDefault();
  send(input.value);
});

$("reset-btn").addEventListener("click", async () => {
  if (!confirm("Start a new session? The agent gets a fresh browser with an empty cart.")) return;
  try {
    await post("/api/reset");
  } catch (error) {
    flash(error.message);
  }
});

// ---------- Profile ----------

const dialog = $("profile-dialog");
const form = $("profile-form");

$("profile-btn").addEventListener("click", () => {
  const p = info.profile;
  for (const [key, value] of Object.entries(p)) if (form.elements[key]) form.elements[key].value = value;
  $("profile-error").textContent = "";
  dialog.showModal();
});
$("profile-cancel").addEventListener("click", () => dialog.close());
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(form));
  data.budgetPerOrder = Number(data.budgetPerOrder);
  try {
    const { profile } = await post("/api/profile", data, "PUT");
    info.profile = profile;
    dialog.close();
  } catch (error) {
    $("profile-error").textContent = error.message;
  }
});

// ---------- Start ----------

async function start() {
  info = await fetch("/api/info").then((r) => r.json());
  $("slot-select").innerHTML = info.deliverySlots.map((s) => `<option>${esc(s)}</option>`).join("");
  $("store-name").textContent = `FreshCart · ${new URL(info.storeUrl).host}`;
  $("model-pill").textContent = info.model;
  renderUsage(info.usage);
  renderWallet(info.wallet);
  if (info.usage.mode === "mock") $("model-pill").hidden = true;
  else if (!info.hasApiKey) {
    $("model-pill").textContent = "No Gemini key";
    $("model-pill").classList.add("offline");
  }
  connect();
}
start();
