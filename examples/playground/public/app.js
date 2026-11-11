// MWF Playground page. Everything from the server is put on the page as text (textContent),
// never as HTML: the agent's messages quote attacker-written shop pages.
"use strict";

const $ = (id) => document.getElementById(id);
function el(tag, props, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = String(v);
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, String(v));
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return n;
}
const clear = (n) => { while (n.firstChild) n.firstChild.remove(); return n; };

const page = { cases: [], byId: {}, selected: "hidden-text", state: null, mine: null, steps: new Map() };

const OUTCOME_CLASS = {
  "ALLOWED": "allow",
  "HELD BY FIREWALL": "held",
  "ATTACK SUCCEEDED": "bad",
  "STOPPED BY AGENT": "neutral",
  "NOT ATTEMPTED": "neutral",
  "NO ORDER": "neutral",
  "ERROR": "neutral",
};
const OUTCOME_TEXT = {
  "ALLOWED": "The purchase went through.",
  "HELD BY FIREWALL": "The firewall stopped the attack. Nothing the attacker wanted was bought.",
  "ATTACK SUCCEEDED": "The attack worked: an order the attacker wanted was placed.",
  "STOPPED BY AGENT": "The agent's own checks stopped it.",
  "NOT ATTEMPTED": "The agent didn't fall for it.",
  "NO ORDER": "No order was placed.",
  "ERROR": "The run broke. It proves nothing either way.",
};
const caseTitle = (id) => page.byId[id]?.title ?? id;

// ---------------------------------------------------------------- scenarios

function renderCases() {
  const box = clear($("cases"));
  for (const c of page.cases) {
    const input = el("input", { type: "radio", name: "case", value: c.id, id: `case-${c.id}` });
    if (c.id === page.selected) input.checked = true;
    input.addEventListener("change", () => { page.selected = c.id; });
    box.append(el("label", { class: "case", for: `case-${c.id}` },
      input,
      el("span", { class: "case-body" },
        el("span", { class: "case-title", text: c.title }),
        el("span", { class: "case-attack", text: c.attack }),
        el("span", { class: "case-expect muted", text: c.expect }),
      ),
    ));
  }
}

// ---------------------------------------------------------------- running

async function run() {
  const firewall = document.querySelector('input[name="fw"]:checked')?.value === "on";
  $("run").disabled = true;
  page.done = "";
  try {
    const res = await fetch("/api/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ case: page.selected, firewall }) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) { $("status").textContent = body.error || "Couldn't start the run."; return; }
    page.mine = body.id;
    if (page.state?.current?.id === body.id) $("status").textContent = "Your run is live below.";
    else $("status").textContent = body.position > 1 ? `Queued: ${body.position - 1} run(s) ahead of yours.` : "Starting your run…";
  } catch {
    $("status").textContent = "Couldn't reach the demo.";
  } finally {
    updateControls();
  }
}

function updateControls() {
  const s = page.state;
  const ready = s && s.phase === "ready";
  const waiting = s && page.mine && (s.current?.id === page.mine || s.queue.some((j) => j.id === page.mine));
  $("run").disabled = !ready || Boolean(waiting);
  if (!s) return;
  if (s.phase !== "ready") $("status").textContent = s.note || "Starting…";
  else if (!waiting) {
    $("status").textContent = page.done || (s.queue.length ? `${s.queue.length} run(s) waiting.` : "Ready.");
  }
}

function onState(s) {
  const prevCurrent = page.state?.current?.id;
  page.state = s;
  if (s.current && s.current.id !== prevCurrent) startLive(s.current);
  if (!s.current) $("now").textContent = s.queue.length ? `${s.queue.length} waiting` : "Idle";
  else $("now").textContent = `Running: ${caseTitle(s.current.case)}, firewall ${s.current.firewall ? "on" : "off"}${s.current.id === page.mine ? " (yours)" : ""}`;
  if (page.mine) {
    const ahead = s.queue.findIndex((j) => j.id === page.mine);
    if (ahead >= 0) $("status").textContent = `Queued: ${ahead + (s.current ? 1 : 0)} run(s) ahead of yours.`;
    else if (s.current?.id === page.mine) $("status").textContent = "Your run is live below.";
  }
  renderRecent(s.recent);
  updateControls();
}

function startLive(job) {
  clear($("log"));
  page.steps.clear();
  $("frame").hidden = true;
  $("frame-empty").hidden = false;
  $("frame-url").textContent = "";
  $("outcome").hidden = true;
  $("log").append(el("li", { class: "sys", text: `${caseTitle(job.case)} — firewall ${job.firewall ? "ON" : "OFF"}` }));
}

function onStep(s) {
  const firewall = s.kind === "guard" || /firewall/i.test(s.label);
  const cls = ["step", s.status, firewall ? "fw" : ""].join(" ");
  const li = el("li", { class: cls },
    el("span", { class: "icon", "aria-hidden": "true", text: s.status === "running" ? "…" : s.status === "failed" ? "✖" : "✔" }),
    el("span", { class: "label", text: s.label }),
    s.detail ? el("span", { class: "detail", text: s.detail }) : null,
  );
  const old = page.steps.get(s.id);
  if (old) old.replaceWith(li); else $("log").append(li);
  page.steps.set(s.id, li);
  scrollLog();
}

function onMessage(m) {
  const li = el("li", { class: `msg ${m.role}` },
    el("span", { class: "who", text: m.role === "user" ? "User" : "Agent" }),
    el("span", { class: "text", text: m.text }),
  );
  if (m.card) {
    li.append(el("div", { class: "card" },
      m.card.warning ? el("div", { class: "warn", text: m.card.warning }) : null,
      el("ul", {}, m.card.lines.map((l) => el("li", { text: l }))),
      el("div", { class: "total", text: `Total ${m.card.total}` }),
    ));
  }
  if (m.order) li.append(el("div", { class: "order", text: `Order ${m.order.id} placed — ${m.order.total}` }));
  $("log").append(li);
  scrollLog();
}

function scrollLog() {
  const feed = $("log").parentElement;
  feed.scrollTop = feed.scrollHeight;
}

function onFrame(f) {
  if (!f.image.startsWith("data:image/jpeg;base64,")) return;
  $("frame").src = f.image;
  $("frame").hidden = false;
  $("frame-empty").hidden = true;
  $("frame-url").textContent = f.url;
}

function onResult(r) {
  const box = clear($("outcome"));
  box.className = `outcome ${OUTCOME_CLASS[r.outcome] || "neutral"}`;
  box.append(
    el("div", { class: "outcome-head" },
      el("span", { class: "pill", text: r.outcome }),
      el("span", { text: `${caseTitle(r.case)}, firewall ${r.firewall ? "on" : "off"}` }),
    ),
    el("p", { text: OUTCOME_TEXT[r.outcome] || "" }),
    r.detail ? el("p", { class: "muted small", text: r.detail }) : null,
    r.orders?.length ? el("p", { class: "small", text: `Orders in the shop's database from this run: ${r.orders.map((o) => `${o.id} $${o.total} [${o.skus.join(", ")}]`).join("; ")}` }) : el("p", { class: "small", text: "No order reached the shop's database in this run." }),
  );
  box.hidden = false;
  if (r.id === page.mine) {
    page.mine = null;
    page.done = "Done. Try the same attack with the firewall the other way.";
  }
  updateControls();
}

function renderRecent(list) {
  const body = clear($("recent"));
  if (!list?.length) {
    body.append(el("tr", {}, el("td", { colspan: "4", class: "muted", text: "No runs yet. Be the first." })));
    return;
  }
  for (const r of list) {
    body.append(el("tr", {},
      el("td", { text: caseTitle(r.case) }),
      el("td", { text: r.firewall ? "on" : "off" }),
      el("td", {}, el("span", { class: `pill ${OUTCOME_CLASS[r.outcome] || "neutral"}`, text: r.outcome })),
      el("td", { class: "small", text: r.detail || "" }),
    ));
  }
}

// ---------------------------------------------------------------- start

function connect() {
  const es = new EventSource("/api/events");
  es.addEventListener("state", (e) => onState(JSON.parse(e.data)));
  es.addEventListener("step", (e) => onStep(JSON.parse(e.data)));
  es.addEventListener("message", (e) => onMessage(JSON.parse(e.data)));
  es.addEventListener("frame", (e) => onFrame(JSON.parse(e.data)));
  es.addEventListener("result", (e) => onResult(JSON.parse(e.data)));
  es.onerror = () => { $("status").textContent = "Reconnecting…"; };
}

document.addEventListener("DOMContentLoaded", async () => {
  $("run").addEventListener("click", run);
  try {
    const res = await fetch("/api/cases");
    const body = await res.json();
    page.cases = body.cases;
    page.byId = Object.fromEntries(body.cases.map((c) => [c.id, c]));
    if (body.repo) $("repo").href = body.repo;
  } catch {
    $("status").textContent = "Couldn't reach the demo.";
  }
  renderCases();
  connect();
});
