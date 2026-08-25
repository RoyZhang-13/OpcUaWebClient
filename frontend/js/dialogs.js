import { apiFetch } from "./api.js";
import { state, appendLog } from "./state.js";
import { hideContextMenu } from "./contextmenu.js";
import { escapeHtml } from "./utils.js";
import { createMonitorItem, removeMonitoredNode, addMonitoredNodeById, openValueDetailModal } from "./monitor.js";

// ─── Add Monitor Dialog ─────────────────────────────────
export function showAddDialog() {
  hideContextMenu();
  const overlay = document.getElementById("add-dialog-overlay");
  const input = document.getElementById("dialog-node-id");
  input.value = "";
  overlay.style.display = "flex";
  setTimeout(() => input.focus(), 50);
}

export function hideAddDialog() {
  document.getElementById("add-dialog-overlay").style.display = "none";
}

export async function confirmAddDialog() {
  const node_id = document.getElementById("dialog-node-id").value.trim();
  if (!node_id) return;
  hideAddDialog();
  await addMonitoredNodeById(node_id);
}

// ─── Item Settings (IndexRange) ─────────────────────────
export function showSettings() {
  hideContextMenu();
  const seq = state.ctxTargetSeq;
  if (seq == null || !state.monitored.has(seq)) return;
  const m = state.monitored.get(seq);
  document.getElementById("settings-node-name").textContent = m.display_name || m.node_id;
  document.getElementById("settings-nodeid").textContent = m.node_id;
  const enabled = !!m.index_range;
  document.getElementById("settings-ir-enable").checked = enabled;
  document.getElementById("settings-ir-value").value = m.index_range || "";
  document.getElementById("settings-ir-row").style.display = enabled ? "block" : "none";
  const overlay = document.getElementById("settings-overlay");
  overlay.dataset.seq = seq;
  overlay.style.display = "flex";
  if (enabled) setTimeout(() => document.getElementById("settings-ir-value").focus(), 50);
}

export function hideSettings() {
  document.getElementById("settings-overlay").style.display = "none";
}

export function onIndexRangeToggle() {
  const enabled = document.getElementById("settings-ir-enable").checked;
  document.getElementById("settings-ir-row").style.display = enabled ? "block" : "none";
  if (enabled) setTimeout(() => document.getElementById("settings-ir-value").focus(), 50);
}

export async function applySettings() {
  const overlay = document.getElementById("settings-overlay");
  const seq = parseInt(overlay.dataset.seq, 10);
  const m = state.monitored.get(seq);
  if (!m) {
    hideSettings();
    return;
  }
  const enabled = document.getElementById("settings-ir-enable").checked;
  const newRange = enabled ? document.getElementById("settings-ir-value").value.trim() || null : null;
  hideSettings();
  if (newRange === m.index_range) return; // nothing changed

  // Unsubscribe old, then re-subscribe with new IndexRange
  await apiFetch(`/api/subscribe?seq=${seq}`, "DELETE");
  m.index_range = newRange;

  const createRes = await createMonitorItem(seq, m.node_id, newRange, "item settings");
  if (!createRes.ok) {
    await removeMonitoredNode(seq);
    return;
  }

  // Update IndexRange badge on the row
  const tr = document.getElementById(`row-${seq}`);
  if (tr) {
    const badge = tr.querySelector(".cell-ir-badge");
    if (badge) {
      badge.textContent = newRange ? `[${newRange}]` : "";
      badge.style.display = newRange ? "inline-block" : "none";
    }
    tr.classList.add("row-updated");
    setTimeout(() => tr.classList.remove("row-updated"), 600);
  }
}

// ─── Node Attributes (Read/Write) ───────────────────────
let lastAttributesValueRaw = null;

export async function showNodeAttributes() {
  let node = state.ctxTargetTreeNode;
  if (!node && state.ctxTargetSeq != null) {
    const m = state.monitored.get(state.ctxTargetSeq);
    if (m) node = { node_id: m.node_id, display_name: m.display_name };
  }
  hideContextMenu();
  if (!node) return;
  const overlay = document.getElementById("attributes-overlay");
  overlay.dataset.nodeId = node.node_id;
  document.getElementById("attributes-node-name").textContent = node.display_name || node.node_id;
  document.getElementById("attributes-nodeid").textContent = node.node_id;
  overlay.style.display = "flex";
  await loadNodeAttributes(node.node_id);
}

export function hideNodeAttributes() {
  document.getElementById("attributes-overlay").style.display = "none";
}

export async function refreshNodeAttributes() {
  const node_id = document.getElementById("attributes-overlay").dataset.nodeId;
  if (!node_id) return;
  await loadNodeAttributes(node_id);
}

async function loadNodeAttributes(node_id) {
  const tbody = document.getElementById("attributes-tbody");
  const msgEl = document.getElementById("attributes-write-msg");
  tbody.innerHTML = '<tr><td colspan="2" class="attributes-loading">Loading…</td></tr>';
  msgEl.textContent = "";

  const res = await apiFetch(`/api/node_attributes?node_id=${encodeURIComponent(node_id)}`);
  if (res?.error) {
    tbody.innerHTML = `<tr><td colspan="2" class="attributes-error">${escapeHtml(res.error)}</td></tr>`;
    return;
  }

  document.getElementById("attributes-node-name").textContent = res.display_name || node_id;
  lastAttributesValueRaw = res.value_raw ?? null;
  tbody.innerHTML = (res.attributes || [])
    .map((a) => {
      // Only the "Value" attribute is writable. Plain scalars get an inline
      // editable input + Write button. Arrays (even of scalars) and structs
      // (NodeId, QualifiedName, ExtensionObject, arrays of structs, etc.) are
      // shown as a truncated read-only preview with a "View" button that
      // opens the structured Array Viewer instead — a single-line text box
      // is impractical for either editing or reading them. The Array Viewer
      // itself offers a Write button for flat scalar arrays.
      if (a.name === "Value" && res.writable) {
        if (res.value_is_complex) {
          return `<tr>
            <td class="attr-name">Value</td>
            <td class="attr-value attr-value-editable">
              <div class="attr-write-inline">
                <span class="attr-value-preview" title="${escapeHtml(a.value)}">${escapeHtml(a.value)}</span>
                <button class="attr-write-btn" title="View full value" onclick="viewNodeAttributeValue()">🔍</button>
              </div>
            </td>
          </tr>`;
        }
        return `<tr>
          <td class="attr-name">Value</td>
          <td class="attr-value attr-value-editable">
            <div class="attr-write-inline">
              <input id="attributes-write-value" type="text" class="dialog-input attr-write-input" value="${escapeHtml(a.value)}" />
              <button class="attr-write-btn" title="Write" onclick="writeAttributeValue()">✎</button>
            </div>
          </td>
        </tr>`;
      }
      const text = a.error ? `<${a.error}>` : a.value;
      return `<tr><td class="attr-name">${escapeHtml(a.name)}</td><td class="attr-value" title="${escapeHtml(text)}">${escapeHtml(text)}</td></tr>`;
    })
    .join("");
}

export function viewNodeAttributeValue() {
  const overlay = document.getElementById("attributes-overlay");
  const node_id = overlay.dataset.nodeId;
  const title = document.getElementById("attributes-node-name").textContent;
  openValueDetailModal({
    title,
    nodeid: node_id,
    valueRaw: lastAttributesValueRaw,
    plainText: "",
    writable: true,
    onWrite: async (editedValue) => {
      const result = await apiFetch("/api/write_structured", "POST", { node_id, value: editedValue });
      if (result?.error) {
        appendLog(`Write failed: ${node_id} | ${result.error}`, "error");
      } else {
        appendLog(`Wrote value to ${node_id}: ${result.written_value}`);
        await loadNodeAttributes(node_id);
      }
      return result;
    },
  });
}

export async function writeAttributeValue() {
  const node_id = document.getElementById("attributes-overlay").dataset.nodeId;
  if (!node_id) return;
  const input = document.getElementById("attributes-write-value");
  if (!input) return;
  const value = input.value;
  const msgEl = document.getElementById("attributes-write-msg");
  msgEl.className = "settings-hint";
  msgEl.textContent = "Writing…";

  const res = await apiFetch("/api/write", "POST", { node_id, value, data_type: "auto" });
  if (res?.error) {
    msgEl.className = "settings-hint attributes-msg-error";
    msgEl.textContent = "Write failed: " + res.error;
    appendLog(`Write failed: ${node_id} | ${res.error}`, "error");
    return;
  }
  msgEl.className = "settings-hint attributes-msg-ok";
  msgEl.textContent = "Write succeeded.";
  appendLog(`Wrote value to ${node_id}: ${res.written_value}`);
  await loadNodeAttributes(node_id);
}
