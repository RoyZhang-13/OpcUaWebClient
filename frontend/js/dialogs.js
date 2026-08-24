import { apiFetch } from "./api.js";
import { state } from "./state.js";
import { hideContextMenu } from "./contextmenu.js";
import { createMonitorItem, removeMonitoredNode, addMonitoredNodeById } from "./monitor.js";

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
