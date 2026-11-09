// MWF console. Reads /v1/console/* with the tenant's API key. Every value is put on the page as
// text (textContent), never as HTML: decisions quote attacker-written pages.
"use strict";

const KEY = "mwf.console.key";
const state = { key: null, maxSeq: 0, selected: null, tab: "decisions", timer: null };

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

const store = {
  get: () => { try { return sessionStorage.getItem(KEY); } catch { return null; } },
  set: (v) => { try { sessionStorage.setItem(KEY, v); } catch { /* memory only */ } },
  del: () => { try { sessionStorage.removeItem(KEY); } catch { /* ignore */ } },
};

async function api(path) {
  const res = await fetch(path, { headers: { authorization: `Bearer ${state.key}` }, cache: "no-store" });
  if (res.status === 401) { disconnect("That key was not accepted."); throw new Error("unauthorized"); }
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
  return res.json();
}

const time = (iso) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const badge = (d) => el("span", { class: `badge ${d}`, text: d });
const pct = (x) => `${(x * 100).toFixed(1)}%`;

// ---------------------------------------------------------------- connect

async function connect(key) {
  state.key = key;
  try {
    const rules = await api("/v1/console/rules");
    store.set(key);
    $("connect").hidden = true;
    document.querySelector(".tabs").hidden = false;
    $("disconnect").hidden = false;
    $("versions").textContent = `policy ${rules.policy_version} · rules ${rules.rule_bundle_version}`;
    show(state.tab);
    poll();
  } catch (e) {
    if (e.message !== "unauthorized") $("connect-error").textContent = "Could not reach the firewall API.";
  }
}

function disconnect(message = "") {
  store.del();
  clearTimeout(state.timer);
  Object.assign(state, { key: null, maxSeq: 0, selected: null });
  clear($("rows"));
  $("connect").hidden = false;
  document.querySelector(".tabs").hidden = true;
  $("disconnect").hidden = true;
  $("versions").textContent = "";
  for (const id of ["decisions", "rules", "battery"]) $(id).hidden = true;
  $("connect-error").textContent = message;
}

// ---------------------------------------------------------------- tabs

function show(tab) {
  state.tab = tab;
  for (const b of document.querySelectorAll(".tabs button")) b.setAttribute("aria-selected", String(b.dataset.tab === tab));
  for (const id of ["decisions", "rules", "battery"]) $(id).hidden = id !== tab;
  if (tab === "rules") loadRules();
  if (tab === "battery") loadBattery();
}

// ---------------------------------------------------------------- decisions

function renderTotals(t) {
  const all = (t.ALLOW || 0) + (t.REVIEW || 0) + (t.BLOCK || 0);
  const stat = (cls, n, label) => el("div", { class: `stat ${cls}` }, el("div", { class: "n", text: n }), el("div", { class: "l", text: label }));
  clear($("totals")).append(stat("", all, "Decisions"), stat("allow", t.ALLOW || 0, "Allowed"), stat("review", t.REVIEW || 0, "Held for review"), stat("block", t.BLOCK || 0, "Blocked"));
}

function row(d, fresh) {
  const tr = el(
    "tr",
    { class: fresh ? "new" : null, "aria-selected": String(state.selected === d.id), tabindex: "0", onclick: () => select(d.id, tr), onkeydown: (e) => { if (e.key === "Enter") select(d.id, tr); } },
    el("td", { class: "mono", text: time(d.created_at) }),
    el("td", { text: d.checkpoint }),
    el("td", {}, badge(d.decision)),
    el("td", { class: "req", title: d.intent || "", text: d.intent || "—" }),
    el("td", { class: "why", title: d.rule_ids.join(", "), text: d.decision === "ALLOW" ? (d.shadow ? `shadow: ${d.shadow}` : "") : d.rule_ids.join(", ") }),
  );
  return tr;
}

async function poll() {
  clearTimeout(state.timer);
  if (!state.key) return;
  try {
    const first = state.maxSeq === 0;
    const data = await api(`/v1/console/decisions?limit=100${first ? "" : `&after=${state.maxSeq}`}`);
    renderTotals(data.totals);
    const rows = $("rows");
    for (const d of [...data.decisions].reverse()) {
      rows.prepend(row(d, !first));
      state.maxSeq = Math.max(state.maxSeq, d.seq);
    }
    while (rows.children.length > 300) rows.lastChild.remove();
    $("empty").hidden = rows.children.length > 0;
  } catch { /* keep polling */ }
  state.timer = setTimeout(poll, 2000);
}

async function select(id, tr) {
  state.selected = id;
  for (const r of $("rows").children) r.setAttribute("aria-selected", "false");
  tr.setAttribute("aria-selected", "true");
  const box = clear($("detail"));
  box.append(el("p", { class: "muted", text: "Loading…" }));
  try {
    renderDetail(await api(`/v1/console/decisions/${encodeURIComponent(id)}`));
  } catch {
    clear(box).append(el("p", { class: "error", text: "Could not load this decision." }));
  }
}

// One graph node, as a person reads it.
function describe(n) {
  const a = n.attrs || {};
  switch (n.type) {
    case "source": return { t: a.kind || "source", v: a.uri || a.item_id || n.id };
    case "span": return { t: `${a.channel || ""} text${a.how ? ` (${a.how})` : ""}`, v: `“${a.text || ""}”` };
    case "value": return { t: `${a.kind} in the action`, v: a.label };
    case "action": return { t: "action", v: a.type };
    case "intent": return { t: "user request", v: a.text };
    case "mandate": return { t: "mandate", v: a.category };
    default: return { t: n.type, v: n.id };
  }
}

function renderDetail(x) {
  const d = x.decision;
  const box = clear($("detail"));
  box.append(el("div", { class: "head" }, badge(d.decision), el("span", { class: "big", text: `${d.checkpoint} checkpoint` }), el("span", { class: "muted", text: new Date(d.created_at).toLocaleString() })));
  if (x.intent) box.append(el("h3", { text: "User asked for" }), el("div", { text: x.intent }));

  box.append(el("h3", { text: d.decision === "ALLOW" ? "Result" : "Why" }));
  for (const r of d.reasons) {
    box.append(el("div", { class: `reason ${d.decision}` }, el("div", { class: "id", text: r.rule_id }), el("div", { class: "msg", text: r.message })));
  }

  if (x.path.length) {
    box.append(el("h3", { text: "Attack path" }));
    const path = el("div", { class: "path" });
    x.path.forEach((n, i) => {
      if (i) path.append(el("div", { class: "arrow", "aria-hidden": "true", text: "↓" }));
      const { t, v } = describe(n);
      const attack = n.attrs && (n.attrs.signal === "hard" || n.attrs.signal === "soft");
      path.append(el("div", { class: `node${attack ? " attack" : ""}` }, el("div", { class: "t", text: attack ? `${t} · ${n.attrs.signal} signal` : t }), el("div", { class: "v", text: v })));
    });
    box.append(path);
  }

  if (d.sensor_scores && d.sensor_scores.length) {
    box.append(el("h3", { text: "Sensor scores" }));
    for (const s of d.sensor_scores) box.append(el("div", { class: "mono", text: `${s.sensor_id} · ${s.sku} · ${s.score === null ? "not scored" : s.score.toFixed(3)}` }));
  }
  if (d.shadow_reasons && d.shadow_reasons.length) {
    box.append(el("h3", { text: "Shadow (recorded, did not decide)" }));
    for (const r of d.shadow_reasons) box.append(el("div", { class: "reason" }, el("div", { class: "id", text: r.rule_id }), el("div", { class: "msg", text: r.message })));
  }

  box.append(el("h3", { text: "Record" }));
  const kv = el("dl", { class: "kv" });
  const add = (k, v) => kv.append(el("dt", { text: k }), el("dd", { class: "mono", text: v }));
  add("decision id", d.id);
  add("ledger entry", `#${x.seq}`);
  add("policy", d.policy_version);
  add("rule bundle", d.rule_bundle_version);
  if (d.action_hash) add("action hash", d.action_hash);
  for (const [k, v] of Object.entries(d.model_hashes || {})) add(`model (${k})`, v);
  box.append(kv);
}

// ---------------------------------------------------------------- rules

function backtestLine(b) {
  return `catches ${b.caught} of ${b.of} attacks that got through · holds ${b.legit_broken} legitimate purchases · softens ${b.weakened} decisions`;
}

async function loadRules() {
  const box = clear($("rules"));
  try {
    const r = await api("/v1/console/rules");
    box.append(el("div", { class: "section-head" }, el("h2", { text: `Rule bundle ${r.rule_bundle_version}` }), el("span", { class: "muted", text: `policy ${r.policy_version} · ${r.static_rules} hand-written signature rules, plus the learned rules and sensors below` })));
    const cards = el("div", { class: "cards" });
    for (const c of r.claim_rules) {
      cards.append(el("div", { class: "card" },
        el("div", { class: "title" }, el("code", { text: c.id }), el("span", { class: `pill ${c.state}`, text: c.state }), el("span", { class: "pill", text: "learned rule · REVIEW only" })),
        el("p", { text: c.description }),
        kvList([["matches", `${c.phrases} phrases, ${c.fingerprints} known claims, ${c.families} attack families`], ["backtest", backtestLine(c.backtest)], ["approved", `${c.approved_by} · ${new Date(c.approved_at).toLocaleString()}`]]),
        c.state === "shadow" ? el("div", { class: "cmd", text: `npm run redteam -- enforce ${c.id} --by <name>` }) : null,
      ));
    }
    for (const s of r.claim_sensors) {
      cards.append(el("div", { class: "card" },
        el("div", { class: "title" }, el("code", { text: s.id }), el("span", { class: `pill ${s.state}`, text: s.state }), el("span", { class: "pill", text: "embedding sensor · REVIEW only" })),
        el("p", { text: s.description }),
        kvList([
          ["model", `${s.model.name} · ${s.model.sha256.slice(0, 16)}…`],
          ["threshold", `${s.threshold} (above all ${s.calibration.negatives} held-out ordinary texts; highest ${s.calibration.max_score})`],
          ["trained on", `${s.positives} attack claims, ${s.negatives} ordinary texts`],
          ["backtest", backtestLine(s.backtest)],
          ["approved", `${s.approved_by} · ${new Date(s.approved_at).toLocaleString()}`],
        ]),
        s.state === "shadow" ? el("div", { class: "cmd", text: `npm run redteam -- enforce ${s.id} --by <name>` }) : null,
      ));
    }
    if (!r.claim_rules.length && !r.claim_sensors.length) cards.append(el("p", { class: "muted", text: "Nothing learned yet." }));
    box.append(cards);
  } catch {
    box.append(el("p", { class: "error", text: "Could not load the rules." }));
  }
}

function kvList(pairs) {
  const kv = el("dl", { class: "kv" });
  for (const [k, v] of pairs) kv.append(el("dt", { text: k }), el("dd", { text: v }));
  return kv;
}

// ---------------------------------------------------------------- battery

async function loadBattery() {
  const box = clear($("battery"));
  try {
    const r = await api("/v1/console/report");
    const stat = (cls, n, label) => el("div", { class: "stat" }, el("div", { class: `n ${cls}`, text: n }), el("div", { class: "l", text: label }));
    box.append(
      el("div", { class: "section-head" }, el("h2", { text: "Test battery" }), el("span", { class: "muted", text: `${r.cases} ground-truth cases · rules ${r.rule_bundle_version || "?"} · policy ${r.policy_version || "?"} · run ${r.generated_at ? new Date(r.generated_at).toLocaleString() : "?"}` })),
      el("div", { class: "hero" },
        stat(r.attackSuccessRate === 0 ? "good" : "bad", pct(r.attackSuccessRate), "Attacks that reached ALLOW"),
        stat(r.falsePositiveRate === 0 ? "good" : "bad", pct(r.falsePositiveRate), "Legitimate purchases held"),
        stat(r.correct === r.cases ? "good" : "bad", `${r.correct}/${r.cases}`, "Match ground truth"),
      ),
    );
    const table = el("table", {}, el("thead", {}, el("tr", {}, ["Category", "Cases", "Correct", "Allowed", "Held", "Blocked"].map((h) => el("th", { text: h })))));
    const body = el("tbody");
    for (const c of r.byCategory) body.append(el("tr", {}, el("td", { text: c.category.replaceAll("_", " ") }), el("td", { text: c.cases }), el("td", { text: c.correct }), el("td", { text: c.allowed }), el("td", { text: c.reviewed }), el("td", { text: c.blocked })));
    table.append(body);
    box.append(el("div", { class: "feed" }, table));
  } catch (e) {
    box.append(el("p", { class: e.status === 404 ? "muted" : "error", text: e.status === 404 ? "No battery report yet. Run: npm run harness -- --json evidence/battery-report.json" : "Could not load the report." }));
  }
}

// ---------------------------------------------------------------- start

document.addEventListener("DOMContentLoaded", () => {
  $("connect-form").addEventListener("submit", (e) => {
    e.preventDefault();
    $("connect-error").textContent = "";
    const key = $("key").value.trim();
    $("key").value = "";
    if (key) connect(key);
  });
  $("disconnect").addEventListener("click", () => disconnect());
  for (const b of document.querySelectorAll(".tabs button")) b.addEventListener("click", () => show(b.dataset.tab));
  const saved = store.get();
  if (saved) connect(saved);
});
