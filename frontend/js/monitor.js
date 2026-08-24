import { apiFetch } from "./api.js";
import { state, appendLog, syncDropHint } from "./state.js";
import { hideContextMenu } from "./contextmenu.js";
import { escapeHtml, flattenArrayEntries, renderArrayEntryRow, bindTableColumnResize } from "./utils.js";

// ─── Subscription creation ──────────────────────────────
export async function createMonitorItem(seq, node_id, index_range = null, reason = "") {
  const subRes = await apiFetch("/api/subscribe", "POST", { seq, node_id, index_range });
  const ok = subRes?.status === "subscribed" || subRes?.status === "already_subscribed";
  if (ok) return { ok: true, response: subRes };

  const msg = subRes?.error || subRes?.message || subRes?.status || "Unknown create monitor item error";
  const rangeText = index_range ? ` [IndexRange=${index_range}]` : "";
  const reasonText = reason ? ` (${reason})` : "";
  appendLog(`Create monitor item failed${reasonText}: ${node_id}${rangeText} | ${msg}`, "error");
  return { ok: false, response: subRes };
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
export function showValueDetail(seq) {
  const m = state.monitored.get(seq);
  if (!m) return;
  document.getElementById("value-detail-name").textContent = m.display_name || m.node_id;
  document.getElementById("value-detail-nodeid").textContent = m.node_id;
  const content = document.getElementById("value-detail-content");
  if (Array.isArray(m.value_raw)) {
    const entries = flattenArrayEntries(m.value_raw);
    const topLevelCount = m.value_raw.length;
    const html =
      `<div class="array-count">${topLevelCount} element${topLevelCount !== 1 ? "s" : ""}</div>` +
      '<table class="array-table"><thead><tr><th>Index / Field</th><th>Value</th></tr></thead><tbody>' +
      entries.map((entry) => renderArrayEntryRow(entry)).join("") +
      "</tbody></table>";
    content.innerHTML = html;
    requestAnimationFrame(() => bindTableColumnResize(content.querySelector(".array-table")));
  } else {
    content.innerHTML = `<pre class="value-detail-text">${escapeHtml(m.value)}</pre>`;
  }
  document.getElementById("value-detail-overlay").style.display = "flex";
}

export function hideValueDetail() {
  document.getElementById("value-detail-overlay").style.display = "none";
}
