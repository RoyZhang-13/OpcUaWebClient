import { apiFetch } from "./api.js";
import { state, appendLog, syncDropHint } from "./state.js";
import { hideContextMenu } from "./contextmenu.js";
import { escapeHtml, flattenArrayEntries, renderArrayEntryRow, bindTableColumnResize, isEditableValue } from "./utils.js";

// ─── Subscription creation ──────────────────────────────
function markRowSubscribeError(seq, message) {
  const tr = document.getElementById(`row-${seq}`);
  if (!tr) return;
  tr.classList.add("row-sub-error");
  tr.title = message ? `Subscribe failed: ${message}` : "Subscribe failed";
}

function clearRowSubscribeError(seq) {
  const tr = document.getElementById(`row-${seq}`);
  if (!tr) return;
  tr.classList.remove("row-sub-error");
  tr.removeAttribute("title");
}

export async function createMonitorItem(seq, node_id, index_range = null, reason = "") {
  const subRes = await apiFetch("/api/subscribe", "POST", { seq, node_id, index_range });
  const ok = subRes?.status === "subscribed" || subRes?.status === "already_subscribed";
  if (ok) {
    clearRowSubscribeError(seq);
    return { ok: true, response: subRes };
  }

  const msg = subRes?.error || subRes?.message || subRes?.status || "Unknown create monitor item error";
  const rangeText = index_range ? ` [IndexRange=${index_range}]` : "";
  const reasonText = reason ? ` (${reason})` : "";
  appendLog(`Create monitor item failed${reasonText}: ${node_id}${rangeText} | ${msg}`, "error");
  markRowSubscribeError(seq, msg);
  return { ok: false, response: subRes };
}

// Re-establish subscriptions for every node already in the monitor table.
// Called after a fresh /api/connect succeeds, so a Disconnect → Connect
// cycle restores the previously monitored list instead of leaving it dead.
export async function resubscribeAllMonitored() {
  const seqs = Array.from(state.monitored.keys());
  for (const seq of seqs) {
    const m = state.monitored.get(seq);
    if (!m) continue;
    const readRes = await apiFetch(`/api/read?node_id=${encodeURIComponent(m.node_id)}`);
    if (readRes && !readRes.error) {
      m.display_name = readRes.display_name ?? m.display_name;
      m.value = readRes.value ?? "";
      m.value_raw = readRes.value_raw ?? null;
      m.data_type = readRes.data_type ?? "";
      m.source_ts = readRes.source_timestamp ?? "";
      m.server_ts = readRes.server_timestamp ?? "";
      m.status_code = readRes.status_code ?? "";
    }
    updateTableRow(seq);
    const createRes = await createMonitorItem(seq, m.node_id, m.index_range, "reconnect resubscribe");
    if (!createRes.ok) {
      appendLog(`Resubscribe failed after reconnect: ${m.node_id}`, "error");
    }
  }
  syncDropHint();
}

// ─── Monitored Table ────────────────────────────────────
export async function addMonitoredNodeById(node_id) {
  if (!node_id) return;
  const readRes = await apiFetch(`/api/read?node_id=${encodeURIComponent(node_id)}`);

  const extractStatusCodeFromError = (msg) => {
    const text = String(msg || "").trim();
    if (!text) return "";

    const enumMatch = text.match(/\bEnumStatusCode_[A-Za-z0-9_]+\b/);
    if (enumMatch) return enumMatch[0];

    const tail = text.match(/\(([A-Za-z][A-Za-z0-9_]+)\)\s*$/);
    if (tail && /^(Bad|Good|Uncertain)/.test(tail[1])) return tail[1];

    const token = text.match(/\b(Bad|Good|Uncertain)[A-Za-z0-9_]+\b/);
    if (token) return token[0];

    return "";
  };

  const statusCodeOnReadError = extractStatusCodeFromError(readRes?.error);
  if (readRes?.error && !statusCodeOnReadError) {
    alert("Read failed: " + readRes.error);
    return;
  }

  const seq = state.monitorSeq++;
  state.monitored.set(seq, {
    seq,
    node_id,
    display_name: readRes.display_name ?? "",
    value: readRes.value ?? "",
    value_raw: readRes.value_raw ?? null,
    data_type: readRes.data_type ?? "",
    source_ts: readRes.source_timestamp ?? "",
    server_ts: readRes.server_timestamp ?? "",
    status_code: readRes.status_code ?? statusCodeOnReadError,
    index_range: null,
  });
  appendTableRow(seq);

  const createRes = await createMonitorItem(seq, node_id, null, "add monitor item");
  if (!createRes.ok) {
    await removeMonitoredNode(seq);
    return;
  }

  syncDropHint();
}

export async function removeMonitoredNode(seq) {
  if (!state.monitored.has(seq)) return;
  state.monitored.delete(seq);
  const tr = document.getElementById(`row-${seq}`);
  if (tr) tr.remove();
  syncDropHint();
  await apiFetch(`/api/subscribe?seq=${seq}`, "DELETE");
}

export async function clearAllMonitored() {
  hideContextMenu();
  const seqs = Array.from(state.monitored.keys());
  state.monitored.clear();
  for (const seq of seqs) {
    apiFetch(`/api/subscribe?seq=${seq}`, "DELETE");
  }
  document.getElementById("monitor-tbody").innerHTML = "";
  state.monitorSeq = 0;
  syncDropHint();
}

export function appendTableRow(seq) {
  const tbody = document.getElementById("monitor-tbody");
  const m = state.monitored.get(seq);
  const tr = document.createElement("tr");
  tr.id = `row-${seq}`;
  tr.innerHTML = `
    <td class="cell-index">${seq}</td>
    <td class="cell-nodeid" title="${escapeHtml(m.node_id)}">${escapeHtml(m.node_id)}<span class="cell-ir-badge" style="display:none"></span></td>
    <td class="cell-name"   title="${escapeHtml(m.display_name)}">${escapeHtml(m.display_name)}</td>
    <td class="cell-value"  title="${escapeHtml(m.value)}">${escapeHtml(m.value)}</td>
    <td class="cell-type">${escapeHtml(m.data_type)}</td>
    <td class="cell-ts">${escapeHtml(m.source_ts)}</td>
    <td class="cell-ts">${escapeHtml(m.server_ts)}</td>
    <td class="cell-status" title="${escapeHtml(m.status_code)}">${escapeHtml(m.status_code)}</td>
    <td class="cell-remove"><button title="Remove" onclick="removeMonitoredNode(${seq})">&#x2715;</button></td>
  `;
  tbody.appendChild(tr);
}

export function updateTableRow(seq) {
  const tr = document.getElementById(`row-${seq}`);
  if (!tr) return;
  const m = state.monitored.get(seq);
  if (!m) return;
  const valCell = tr.querySelector(".cell-value");
  if (valCell) {
    valCell.textContent = m.value;
    valCell.title = m.value;
  }
  const typeCell = tr.querySelector(".cell-type");
  if (typeCell) typeCell.textContent = m.data_type;
  const tsCells = tr.querySelectorAll(".cell-ts");
  if (tsCells[0]) tsCells[0].textContent = m.source_ts;
  if (tsCells[1]) tsCells[1].textContent = m.server_ts;
  const statusCell = tr.querySelector(".cell-status");
  if (statusCell) {
    statusCell.textContent = m.status_code;
    statusCell.title = m.status_code;
  }
  tr.classList.add("row-updated");
  setTimeout(() => tr.classList.remove("row-updated"), 500);
}

// ─── Value Detail ────────────────────────────────────────
let currentDetailWrite = null;

export function openValueDetailModal({ title, nodeid, valueRaw, plainText, writable = false, onWrite = null }) {
  document.getElementById("value-detail-name").textContent = title || "";
  document.getElementById("value-detail-nodeid").textContent = nodeid || "";
  const content = document.getElementById("value-detail-content");
  const msgEl = document.getElementById("value-detail-write-msg");
  const writeBtn = document.getElementById("value-detail-write-btn");
  if (msgEl) msgEl.textContent = "";
  const isStruct = valueRaw && !Array.isArray(valueRaw) && valueRaw._type === "struct";
  // Flat scalar arrays are always editable. Structs and arrays of structs are
  // editable only for their scalar leaf fields, and only when the backend
  // marked the struct type as safely round-trippable (see `editable` flag in
  // `_serialize_element`, e.g. QualifiedName/LocalizedText/decoded custom
  // structs — not NodeId or raw undecoded ExtensionObject).
  const editable = writable && typeof onWrite === "function" && isEditableValue(valueRaw);
  currentDetailWrite = editable ? { onWrite, valueRaw } : null;
  if (writeBtn) writeBtn.style.display = editable ? "inline-block" : "none";
  if (Array.isArray(valueRaw) || isStruct) {
    const entries = flattenArrayEntries(valueRaw);
    const countLabel = Array.isArray(valueRaw) ? `${valueRaw.length} element${valueRaw.length !== 1 ? "s" : ""}` : "1 struct";
    const html =
      `<div class="array-count">${countLabel}</div>` +
      '<table class="array-table"><thead><tr><th>Index / Field</th><th>Value</th></tr></thead><tbody>' +
      entries.map((entry) => renderArrayEntryRow(entry, editable)).join("") +
      "</tbody></table>";
    content.innerHTML = html;
    requestAnimationFrame(() => bindTableColumnResize(content.querySelector(".array-table")));
  } else {
    content.innerHTML = `<pre class="value-detail-text">${escapeHtml(plainText ?? "")}</pre>`;
  }
  document.getElementById("value-detail-overlay").style.display = "flex";
}

export async function writeValueDetail() {
  if (!currentDetailWrite?.onWrite) return;
  const edited = JSON.parse(JSON.stringify(currentDetailWrite.valueRaw));
  const inputs = Array.from(document.querySelectorAll("#value-detail-content .array-val-input[data-path]"));
  for (const el of inputs) {
    let path;
    try {
      path = JSON.parse(el.dataset.path);
    } catch {
      continue;
    }
    if (!Array.isArray(path) || path.length === 0) continue;
    let node = edited;
    for (const seg of path.slice(0, -1)) {
      node = typeof seg === "number" ? node?.[seg] : node?.fields?.[seg];
    }
    if (node == null) continue;
    const lastSeg = path[path.length - 1];
    const target = typeof lastSeg === "number" ? node[lastSeg] : node?.fields?.[lastSeg];
    if (target && target._type === "scalar") {
      target.value = el.value;
    }
  }
  const msgEl = document.getElementById("value-detail-write-msg");
  if (msgEl) {
    msgEl.className = "settings-hint";
    msgEl.textContent = "Writing…";
  }
  const result = await currentDetailWrite.onWrite(edited);
  if (!msgEl) return;
  if (result?.error) {
    msgEl.className = "settings-hint attributes-msg-error";
    msgEl.textContent = "Write failed: " + result.error;
  } else {
    msgEl.className = "settings-hint attributes-msg-ok";
    msgEl.textContent = "Write succeeded.";
  }
}

export function showValueDetail(seq) {
  const m = state.monitored.get(seq);
  if (!m) return;
  openValueDetailModal({
    title: m.display_name || m.node_id,
    nodeid: m.node_id,
    valueRaw: m.value_raw,
    plainText: m.value,
  });
}

export function hideValueDetail() {
  document.getElementById("value-detail-overlay").style.display = "none";
}
