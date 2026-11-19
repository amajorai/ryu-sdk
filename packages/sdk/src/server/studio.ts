/**
 * The Ryu dev studio: a single self-contained page served by
 * `createRyuServer({ studio: true })` (what `ryu dev --studio` starts).
 *
 * It talks only to the server's own API: lists agents, workflows, and tools;
 * chats with an agent over the SSE stream with tool-call, tool-result, handoff,
 * and approval rendering; runs a workflow against its step graph with live
 * state and resume of suspended steps; executes tools; and browses local run
 * traces. All dynamic content is written with `textContent` (no HTML
 * injection), and the page needs no network access beyond its own origin.
 *
 * `"__RYU_BASE_PATH__"` (with its quotes) is replaced by the JSON-encoded API
 * base path at serve time.
 */

export const STUDIO_BASE_PATH_PLACEHOLDER = '"__RYU_BASE_PATH__"';

export const STUDIO_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ryu Studio</title>
<style>
:root{--bg:#fafafa;--panel:#ffffff;--text:#18181b;--muted:#71717a;--border:#e4e4e7;--accent:#2563eb;--ok:#16a34a;--warn:#d97706;--err:#dc2626;--code:#f4f4f5;color-scheme:light}
@media (prefers-color-scheme: dark){:root{--bg:#09090b;--panel:#18181b;--text:#fafafa;--muted:#a1a1aa;--border:#27272a;--accent:#60a5fa;--ok:#4ade80;--warn:#fbbf24;--err:#f87171;--code:#27272a;color-scheme:dark}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
header{display:flex;align-items:center;gap:12px;padding:10px 16px;border-bottom:1px solid var(--border);background:var(--panel)}
header h1{font-size:15px;margin:0}
header .muted{font-size:12px}
.layout{display:grid;grid-template-columns:240px 1fr;min-height:calc(100vh - 45px)}
nav{border-right:1px solid var(--border);background:var(--panel);padding:12px;overflow:auto}
nav h2{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:14px 0 6px}
nav button{display:block;width:100%;text-align:left;padding:6px 8px;border:0;border-radius:6px;background:transparent;color:var(--text);cursor:pointer;font:inherit}
nav button:hover,nav button[aria-current="true"]{background:var(--code)}
main{padding:16px;overflow:auto;min-width:0}
.muted{color:var(--muted)}
.card{background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:12px;margin:0 0 12px}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
textarea,input,select{width:100%;font:13px ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--panel);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:8px}
textarea{min-height:72px;resize:vertical}
.btn{padding:6px 12px;border-radius:6px;border:1px solid var(--border);background:var(--panel);color:var(--text);cursor:pointer;font:inherit}
.btn.primary{background:var(--accent);border-color:var(--accent);color:#fff}
.btn:disabled{opacity:.5;cursor:default}
pre{margin:6px 0 0;background:var(--code);padding:8px;border-radius:6px;overflow:auto;font:12px ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;word-break:break-word}
.msg{margin:0 0 10px}
.msg .who{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
.msg .body{white-space:pre-wrap}
.tool{border-left:3px solid var(--accent);padding:6px 10px;margin:6px 0;background:var(--code);border-radius:0 6px 6px 0}
.tool.approval{border-left-color:var(--warn)}
.tool.error{border-left-color:var(--err)}
.graph{display:flex;gap:8px;align-items:stretch;overflow:auto;padding:4px 0}
.node{border:1px solid var(--border);border-radius:8px;padding:8px 10px;min-width:120px;background:var(--panel)}
.node .kind{font-size:11px;color:var(--muted)}
.node .kids{display:flex;flex-direction:column;gap:6px;margin-top:6px}
.node[data-status="running"]{border-color:var(--accent);box-shadow:0 0 0 2px color-mix(in srgb,var(--accent) 30%,transparent)}
.node[data-status="success"]{border-color:var(--ok)}
.node[data-status="suspended"]{border-color:var(--warn)}
.node[data-status="failed"]{border-color:var(--err)}
.arrow{align-self:center;color:var(--muted)}
.pill{display:inline-block;font-size:11px;padding:1px 8px;border-radius:999px;border:1px solid var(--border)}
.pill.success{color:var(--ok)}.pill.failed{color:var(--err)}.pill.suspended,.pill.paused{color:var(--warn)}.pill.running{color:var(--accent)}
table{width:100%;border-collapse:collapse;font-size:13px}
td,th{text-align:left;padding:6px;border-bottom:1px solid var(--border);vertical-align:top}
tr.clickable{cursor:pointer}
tr.clickable:hover{background:var(--code)}
@media (max-width:720px){.layout{grid-template-columns:1fr}nav{border-right:0;border-bottom:1px solid var(--border)}main{padding:12px 16px}}
</style>
</head>
<body>
<header><h1>Ryu Studio</h1><span class="muted" id="base"></span></header>
<div class="layout">
<nav aria-label="Resources" id="nav"></nav>
<main id="main"><p class="muted">Loading…</p></main>
</div>
<script>
"use strict";
const BASE = "__RYU_BASE_PATH__";
document.getElementById("base").textContent = BASE + " · local";
const main = document.getElementById("main");
const nav = document.getElementById("nav");

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat()) {
    if (c === undefined || c === null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
const pretty = (v) => v === undefined ? "" : JSON.stringify(v, null, 2);
const pill = (s) => h("span", { class: "pill " + s }, s);
function api(path, init) {
  return fetch(BASE + path, init).then(async (r) => {
    const body = r.headers.get("content-type")?.includes("json") ? await r.json() : await r.text();
    if (!r.ok) throw new Error(body?.error?.message || ("HTTP " + r.status));
    return body;
  });
}
const post = (path, body) => api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function streamSse(path, body, onEvent) {
  const res = await fetch(BASE + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok || !res.body) {
    let message = "HTTP " + res.status;
    try { message = (await res.json()).error.message; } catch {}
    throw new Error(message);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\\n\\n")) >= 0) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      let event = "message"; const data = [];
      for (const line of frame.split("\\n")) {
        if (line.startsWith("event: ")) event = line.slice(7);
        else if (line.startsWith("data: ")) data.push(line.slice(6));
      }
      if (data.length) onEvent(event, JSON.parse(data.join("\\n")));
    }
  }
}

function parseJson(text, label) {
  if (text.trim() === "") return undefined;
  try { return JSON.parse(text); } catch { throw new Error(label + " is not valid JSON"); }
}

const state = { current: null };
function select(kind, id, render) {
  state.current = kind + ":" + id;
  for (const b of nav.querySelectorAll("button")) b.setAttribute("aria-current", String(b.dataset.key === state.current));
  main.replaceChildren();
  render();
}

// ── Agents ──────────────────────────────────────────────────────────────────
function renderAgent(agent) {
  const log = h("div", { "aria-live": "polite" });
  const input = h("textarea", { placeholder: "Message " + agent.name + "…", "aria-label": "Message" });
  const send = h("button", { class: "btn primary" }, "Send");
  const history = [];
  const info = agent.kind === "network"
    ? h("p", { class: "muted" }, "Network · entry " + agent.entry + " · members " + agent.members.join(", "))
    : h("p", { class: "muted" }, "Model " + agent.model + (agent.tools.length ? " · tools: " + agent.tools.map((t) => t.name + (t.needsApproval ? " (approval)" : "")).join(", ") : ""));

  async function submit() {
    const text = input.value.trim();
    if (!text) return;
    input.value = ""; send.disabled = true;
    log.append(h("div", { class: "msg" }, h("div", { class: "who" }, "you"), h("div", { class: "body" }, text)));
    const body = h("div", { class: "body" });
    const turn = h("div", { class: "msg" }, h("div", { class: "who" }, agent.name), body);
    log.append(turn);
    let reply = "";
    const tools = new Map();
    const payload = history.length === 0 ? { prompt: text } : { messages: [...history, { role: "user", content: text }] };
    try {
      await streamSse("/agents/" + encodeURIComponent(agent.id) + "/stream", payload, (event, data) => {
        if (event === "text") { reply += data.content; body.textContent = reply; }
        else if (event === "tool_call") {
          const card = h("div", { class: "tool" }, h("strong", {}, "tool " + data.name), h("pre", {}, pretty(data.input)));
          tools.set(data.id, card); turn.append(card);
        } else if (event === "tool_result") {
          const card = tools.get(data.id) || turn;
          card.append(h("div", { class: "muted" }, "result"), h("pre", {}, pretty(data.output)));
        } else if (event === "approval_requested") {
          const card = h("div", { class: "tool approval" }, h("strong", {}, "approval needed: " + (data.name || "tool")), h("div", {}, data.summary), h("pre", {}, pretty(data.input)));
          const decide = (approved) => async () => {
            for (const b of card.querySelectorAll("button")) b.disabled = true;
            try { await post("/approvals/" + encodeURIComponent(data.approvalId), { approved }); card.append(h("div", { class: "muted" }, approved ? "approved" : "denied")); }
            catch (e) { card.append(h("div", { class: "muted" }, e.message)); }
          };
          card.append(h("div", { class: "row" }, h("button", { class: "btn primary", onclick: decide(true) }, "Approve"), h("button", { class: "btn", onclick: decide(false) }, "Deny")));
          turn.append(card);
        } else if (event === "handoff") {
          turn.append(h("div", { class: "muted" }, "handoff " + data.from + " → " + data.to + (data.reason ? " (" + data.reason + ")" : "")));
        } else if (event === "auth_required") {
          turn.append(h("div", { class: "tool approval" }, "Connect an account to continue: " + (data.url || data.message || data.tool)));
        } else if (event === "output_repair") {
          turn.append(h("div", { class: "muted" }, "repairing structured output (attempt " + data.attempt + ")"));
        } else if (event === "result") {
          if (!reply && data.text) { reply = data.text; body.textContent = reply; }
          if (data.output !== undefined) turn.append(h("pre", {}, pretty(data.output)));
          turn.append(h("div", { class: "muted" }, data.steps + " step(s)" + (data.usage ? " · " + data.usage.totalTokens + " tokens" : "")));
        } else if (event === "error") {
          turn.append(h("div", { class: "tool error" }, data.message));
        }
      });
      history.push({ role: "user", content: text });
      if (reply) history.push({ role: "assistant", content: reply });
    } catch (e) {
      turn.append(h("div", { class: "tool error" }, e.message));
    } finally { send.disabled = false; }
  }
  send.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit(); });
  main.append(
    h("h2", {}, agent.name), info,
    agent.description ? h("p", {}, agent.description) : null,
    h("div", { class: "card" }, log),
    h("div", { class: "card" }, input, h("div", { class: "row", style: "margin-top:8px" }, send, h("span", { class: "muted" }, "Ctrl/⌘ + Enter to send")))
  );
}

// ── Workflows ───────────────────────────────────────────────────────────────
function graphNode(node, index) {
  const el = h("div", { class: "node", "data-node": node.id },
    h("div", { class: "kind" }, node.kind), h("div", {}, node.label));
  index.set(node.id, el);
  if (node.children?.length) el.append(h("div", { class: "kids" }, node.children.map((c) => graphNode(c, index))));
  return el;
}
function renderWorkflow(wf) {
  const index = new Map();
  const graph = h("div", { class: "graph" });
  wf.graph.nodes.forEach((n, i) => { if (i) graph.append(h("span", { class: "arrow", "aria-hidden": "true" }, "→")); graph.append(graphNode(n, index)); });
  const input = h("textarea", { "aria-label": "Input data (JSON)" }, "{}");
  const run = h("button", { class: "btn primary" }, "Run");
  const status = h("div", { class: "row" });
  const stateView = h("pre", {}, "{}");
  const events = h("pre", {}, "");
  const resume = h("div", {});
  const runs = h("tbody", {});
  const mark = (stepId, s) => { const el = index.get(stepId); if (el) el.dataset.status = s; };
  const reset = () => { for (const el of index.values()) delete el.dataset.status; };

  async function drive(path, body) {
    run.disabled = true; resume.replaceChildren(); events.textContent = "";
    try {
      await streamSse(path, body, (event, data) => {
        if (event === "events") {
          events.textContent += data.type + (data.stepId ? " " + data.path : "") + "\\n";
          if (data.type === "step-start") mark(data.stepId, "running");
          else if (data.type === "step-result") mark(data.stepId, "success");
          else if (data.type === "step-suspended") mark(data.stepId, "suspended");
          else if (data.type === "step-error") mark(data.stepId, "failed");
        } else if (event === "values") { stateView.textContent = pretty({ status: data.status, state: data.state, output: data.output }); }
        else if (event === "run") { status.replaceChildren(h("span", { class: "muted" }, "run " + data.runId), pill("running")); }
        else if (event === "result") {
          status.replaceChildren(h("span", { class: "muted" }, "run " + data.runId), pill(data.status));
          if (data.status === "success") events.textContent += "result: " + JSON.stringify(data.result) + "\\n";
          if (data.status === "failed") events.textContent += "error: " + data.error + "\\n";
          if (data.status === "suspended") showResume(data);
        } else if (event === "error") { events.textContent += "error: " + data.message + "\\n"; }
      });
    } catch (e) { events.textContent += "error: " + e.message + "\\n"; }
    finally { run.disabled = false; loadRuns(); }
  }
  function showResume(result) {
    const pick = h("select", { "aria-label": "Suspended step" }, result.suspended.map((s) => h("option", { value: s.path }, s.path)));
    const data = h("textarea", { "aria-label": "Resume data (JSON)" }, "{}");
    const go = h("button", { class: "btn primary" }, "Resume");
    go.addEventListener("click", () => {
      let resumeData;
      try { resumeData = parseJson(data.value, "Resume data"); } catch (e) { events.textContent += e.message + "\\n"; return; }
      drive("/workflows/" + encodeURIComponent(wf.id) + "/runs/" + encodeURIComponent(result.runId) + "/resume/stream", { step: pick.value, resumeData, streamMode: ["events", "values"] });
    });
    resume.replaceChildren(h("div", { class: "card" }, h("strong", {}, "Suspended"),
      result.suspended.map((s) => h("pre", {}, s.path + " " + pretty(s.payload))), pick, data, h("div", { class: "row", style: "margin-top:8px" }, go)));
  }
  async function loadRuns() {
    try {
      const { runs: list } = await api("/workflows/" + encodeURIComponent(wf.id) + "/runs");
      runs.replaceChildren(...list.map((r) => h("tr", { class: "clickable", onclick: () => showTrace(r.id) },
        h("td", {}, r.id.slice(0, 8)), h("td", {}, pill(r.status)), h("td", {}, new Date(r.startedAt).toLocaleTimeString()), h("td", {}, r.eventCount))));
    } catch (e) { runs.replaceChildren(h("tr", {}, h("td", {}, e.message))); }
  }
  run.addEventListener("click", () => {
    let inputData;
    try { inputData = parseJson(input.value, "Input"); } catch (e) { events.textContent = e.message; return; }
    reset();
    drive("/workflows/" + encodeURIComponent(wf.id) + "/stream", { inputData, streamMode: ["events", "values"] });
  });
  main.append(h("h2", {}, wf.name), wf.description ? h("p", {}, wf.description) : null,
    h("div", { class: "card" }, h("strong", {}, "Steps"), graph),
    h("div", { class: "card" }, h("label", {}, "Input data", input), h("details", {}, h("summary", { class: "muted" }, "Input schema"), h("pre", {}, pretty(wf.inputSchema))), h("div", { class: "row", style: "margin-top:8px" }, run, status)),
    resume,
    h("div", { class: "card" }, h("strong", {}, "Live state"), stateView, h("strong", {}, "Events"), events),
    h("div", { class: "card" }, h("strong", {}, "Runs"), h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, "Run"), h("th", {}, "Status"), h("th", {}, "Started"), h("th", {}, "Events"))), runs)));
  loadRuns();
}

// ── Tools ───────────────────────────────────────────────────────────────────
function renderTool(tool) {
  const input = h("textarea", { "aria-label": "Tool input (JSON)" }, "{}");
  const out = h("pre", {}, "");
  const exec = h("button", { class: "btn primary" }, "Execute");
  exec.addEventListener("click", async () => {
    exec.disabled = true;
    try { out.textContent = pretty(await post("/tools/" + encodeURIComponent(tool.id) + "/execute", { input: parseJson(input.value, "Input") ?? {} })); }
    catch (e) { out.textContent = e.message; }
    finally { exec.disabled = false; }
  });
  main.append(h("h2", {}, tool.name), tool.description ? h("p", {}, tool.description) : null,
    tool.needsApproval ? h("p", { class: "muted" }, "Requires approval when an agent calls it.") : null,
    h("div", { class: "card" }, h("strong", {}, "Input schema"), h("pre", {}, pretty(tool.schema))),
    h("div", { class: "card" }, input, h("div", { class: "row", style: "margin-top:8px" }, exec), out));
}

// ── Traces ──────────────────────────────────────────────────────────────────
async function showTrace(id) {
  state.current = "trace:" + id;
  main.replaceChildren(h("p", { class: "muted" }, "Loading…"));
  try {
    const r = await api("/traces/" + encodeURIComponent(id));
    main.replaceChildren(h("h2", {}, r.kind + " · " + r.target), h("div", { class: "row" }, pill(r.status), h("span", { class: "muted" }, r.id), h("span", { class: "muted" }, r.startedAt)),
      r.error ? h("div", { class: "tool error" }, r.error) : null,
      h("div", { class: "card" }, h("strong", {}, "Input"), h("pre", {}, pretty(r.input))),
      r.output !== undefined ? h("div", { class: "card" }, h("strong", {}, "Output"), h("pre", {}, pretty(r.output))) : null,
      h("div", { class: "card" }, h("strong", {}, "Events (" + r.events.length + (r.eventsDropped ? ", " + r.eventsDropped + " dropped" : "") + ")"),
        h("table", {}, h("tbody", {}, r.events.map((e) => h("tr", {}, h("td", { class: "muted" }, "+" + e.offsetMs + "ms"), h("td", {}, e.type), h("td", {}, h("pre", {}, pretty(e.data)))))))));
  } catch (e) { main.replaceChildren(h("p", {}, e.message)); }
}
async function renderTraces() {
  const body = h("tbody", {});
  main.append(h("h2", {}, "Traces"), h("p", { class: "muted" }, "Recent local runs, newest first. Kept in memory for this dev session."), h("div", { class: "card" }, h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, "Kind"), h("th", {}, "Target"), h("th", {}, "Status"), h("th", {}, "Started"), h("th", {}, "Events"))), body)));
  try {
    const { runs } = await api("/traces?limit=100");
    body.replaceChildren(...runs.map((r) => h("tr", { class: "clickable", onclick: () => showTrace(r.id) }, h("td", {}, r.kind), h("td", {}, r.target), h("td", {}, pill(r.status)), h("td", {}, new Date(r.startedAt).toLocaleTimeString()), h("td", {}, r.eventCount))));
    if (!runs.length) body.replaceChildren(h("tr", {}, h("td", { colspan: "5", class: "muted" }, "No runs yet.")));
  } catch (e) { body.replaceChildren(h("tr", {}, h("td", {}, e.message))); }
}

// ── Navigation ──────────────────────────────────────────────────────────────
async function boot() {
  try {
    const [{ agents }, { workflows }, { tools }] = await Promise.all([api("/agents"), api("/workflows"), api("/tools")]);
    const section = (title, items, kind, render) => {
      nav.append(h("h2", {}, title));
      if (!items.length) nav.append(h("div", { class: "muted" }, "None"));
      for (const item of items) nav.append(h("button", { "data-key": kind + ":" + item.id, onclick: () => select(kind, item.id, () => render(item)) }, item.name || item.id));
    };
    section("Agents", agents, "agent", renderAgent);
    section("Workflows", workflows, "workflow", renderWorkflow);
    section("Tools", tools, "tool", renderTool);
    nav.append(h("h2", {}, "Observe"), h("button", { "data-key": "traces:all", onclick: () => select("traces", "all", renderTraces) }, "Traces"));
    const first = agents[0] ? ["agent", agents[0], renderAgent] : workflows[0] ? ["workflow", workflows[0], renderWorkflow] : tools[0] ? ["tool", tools[0], renderTool] : null;
    if (first) select(first[0], first[1].id, () => first[2](first[1]));
    else select("traces", "all", renderTraces);
  } catch (e) {
    main.replaceChildren(h("p", {}, "Could not load the server: " + e.message));
  }
}
boot();
</script>
</body>
</html>
`;
