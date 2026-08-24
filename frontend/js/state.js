// ─── Shared application state ─────────────────────────
export const API = "";

export const state = {
  ws: null,
  // seq -> { seq, node_id, display_name, value, value_raw, data_type, source_ts, server_ts, status_code, index_range }
  monitored: new Map(),
  monitorSeq: 0,
  // seq of the row that was most recently right-clicked
  ctxTargetSeq: null,
  // selected tree nodes for multi-select / drag
  selectedTreeNodes: new Map(),
  anchorTreeRow: null, // anchor for Shift-range selection
};

const LOG_MAX_LINES = 300;

export function getNowTimeText() {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${hh}:${mm}:${ss}.${ms}`;
}

export function appendLog(message, level = "info") {
  const list = document.getElementById("log-list");
  if (!list) return;
  const empty = list.querySelector(".log-empty");
  if (empty) empty.remove();

  const row = document.createElement("div");
  row.className = `log-entry${level === "error" ? " log-entry-error" : ""}`;
  row.textContent = `[${getNowTimeText()}] ${message}`;
  list.appendChild(row);

  while (list.children.length > LOG_MAX_LINES) {
    list.removeChild(list.firstChild);
  }
  list.scrollTop = list.scrollHeight;
}

export function clearLogPanel() {
  const list = document.getElementById("log-list");
  if (!list) return;
  list.innerHTML = '<div class="log-empty">No logs yet.</div>';
}

export function setConnected(connected) {
  const badge = document.getElementById("conn-status");
  const btn = document.getElementById("btn-connect");
  badge.textContent = connected ? "Connected" : "Disconnected";
  badge.className = connected ? "badge badge-connected" : "badge badge-disconnected";
  btn.textContent = connected ? "Disconnect" : "Connect";
}

export function syncDropHint() {
  const hint = document.getElementById("drop-hint");
  if (hint) hint.style.display = state.monitored.size === 0 ? "block" : "none";
}
