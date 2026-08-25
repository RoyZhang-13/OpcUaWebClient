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

// ─── Monitored Item Setting ──────────────────────────────
export async function showMonitoredItemSettings() {
  hideContextMenu();
  const seq = state.ctxTargetSeq;
  if (seq == null || !state.monitored.has(seq)) return;
  const res = await apiFetch(`/api/monitored_item_settings?seq=${seq}`);
  if (!res || res.error) {
    appendLog(`Failed to load monitored item settings: ${res?.error || "unknown error"}`, "error");
    return;
  }
  const overlay = document.getElementById("monitored-item-settings-overlay");
  overlay.dataset.seq = seq;
  document.getElementById("mi-settings-node-id").value = res.node_id ?? "";
  document.getElementById("mi-settings-sampling-interval").value = res.sampling_interval ?? "";
  document.getElementById("mi-settings-queue-size").value = res.queue_size ?? 1;
  document.getElementById("mi-settings-discard-oldest").checked = !!res.discard_oldest;
  document.getElementById("mi-settings-monitoring-mode").value = res.monitoring_mode ?? "Reporting";
  overlay.style.display = "flex";
}

export function hideMonitoredItemSettings() {
  document.getElementById("monitored-item-settings-overlay").style.display = "none";
}

export async function applyMonitoredItemSettings() {
  const overlay = document.getElementById("monitored-item-settings-overlay");
  const seq = parseInt(overlay.dataset.seq, 10);
  const payload = {
    seq,
    sampling_interval: parseFloat(document.getElementById("mi-settings-sampling-interval").value),
    queue_size: parseInt(document.getElementById("mi-settings-queue-size").value, 10),
    discard_oldest: document.getElementById("mi-settings-discard-oldest").checked,
    monitoring_mode: document.getElementById("mi-settings-monitoring-mode").value,
  };
  if (Number.isNaN(payload.sampling_interval)) payload.sampling_interval = null;
  if (Number.isNaN(payload.queue_size)) payload.queue_size = null;
  const res = await apiFetch("/api/monitored_item_settings", "POST", payload);
  if (!res || res.error) {
    appendLog(`Failed to update monitored item settings: ${res?.error || "unknown error"}`, "error");
    return;
  }
  const m = state.monitored.get(seq);
  if (m) {
    m.sampling_interval = res.sampling_interval;
    m.queue_size = res.queue_size;
    m.discard_oldest = res.discard_oldest;
    m.monitoring_mode = res.monitoring_mode;
  }
  appendLog(`Monitored item settings updated: ${res.node_id}`, "info");
  hideMonitoredItemSettings();
}

// ─── Subscription Setting ────────────────────────────────
export async function showSubscriptionSettings() {
  hideContextMenu();
  const res = await apiFetch("/api/subscription_settings");
  if (!res || res.error) {
    appendLog(`Failed to load subscription settings: ${res?.error || "unknown error"}`, "error");
    return;
  }
  document.getElementById("sub-settings-name").value = res.name ?? "";
  document.getElementById("sub-settings-id").value = res.subscription_id ?? "(not active)";
  document.getElementById("sub-settings-publishing-interval").value = res.publishing_interval ?? "";
  document.getElementById("sub-settings-keep-alive-count").value = res.keep_alive_count ?? "";
  document.getElementById("sub-settings-lifetime-count").value = res.lifetime_count ?? "";
  document.getElementById("sub-settings-max-notifications").value = res.max_notifications_per_publish ?? "";
  document.getElementById("sub-settings-priority").value = res.priority ?? "";
  document.getElementById("sub-settings-timestamps").value = res.timestamps_to_return ?? "";
  document.getElementById("sub-settings-publishing-enabled").checked = !!res.publishing_enabled;
  document.getElementById("subscription-settings-overlay").style.display = "flex";
}

export function hideSubscriptionSettings() {
  document.getElementById("subscription-settings-overlay").style.display = "none";
}

export async function applySubscriptionSettings() {
  const payload = {
    name: document.getElementById("sub-settings-name").value.trim() || null,
    publishing_interval: parseFloat(document.getElementById("sub-settings-publishing-interval").value),
    keep_alive_count: parseInt(document.getElementById("sub-settings-keep-alive-count").value, 10),
    lifetime_count: parseInt(document.getElementById("sub-settings-lifetime-count").value, 10),
    max_notifications_per_publish: parseInt(document.getElementById("sub-settings-max-notifications").value, 10),
    priority: parseInt(document.getElementById("sub-settings-priority").value, 10),
    timestamps_to_return: document.getElementById("sub-settings-timestamps").value.trim() || null,
    publishing_enabled: document.getElementById("sub-settings-publishing-enabled").checked,
  };
  for (const key of ["publishing_interval", "keep_alive_count", "lifetime_count", "max_notifications_per_publish", "priority"]) {
    if (Number.isNaN(payload[key])) payload[key] = null;
  }
  const res = await apiFetch("/api/subscription_settings", "POST", payload);
  if (!res || res.error) {
    appendLog(`Failed to update subscription settings: ${res?.error || "unknown error"}`, "error");
    return;
  }
  document.getElementById("sub-settings-id").value = res.subscription_id ?? "(not active)";
  document.getElementById("sub-settings-publishing-interval").value = res.publishing_interval ?? "";
  document.getElementById("sub-settings-keep-alive-count").value = res.keep_alive_count ?? "";
  document.getElementById("sub-settings-lifetime-count").value = res.lifetime_count ?? "";
  appendLog("Subscription settings updated", "info");
  hideSubscriptionSettings();
}

// ─── Node Attributes (Read/Write) ───────────────────────
let lastAttributesValueRaw = null;

export async function showNodeAttributes() {
  let node = state.ctxTargetTreeNode;
  let index_range = null;
  if (!node && state.ctxTargetSeq != null) {
    const m = state.monitored.get(state.ctxTargetSeq);
    if (m) {
      node = { node_id: m.node_id, display_name: m.display_name };
      index_range = m.index_range || null;
    }
  }
  hideContextMenu();
  if (!node) return;
  const overlay = document.getElementById("attributes-overlay");
  overlay.dataset.nodeId = node.node_id;
  overlay.dataset.indexRange = index_range || "";
  document.getElementById("attributes-node-name").textContent = node.display_name || node.node_id;
  document.getElementById("attributes-nodeid").textContent = node.node_id + (index_range ? ` [${index_range}]` : "");
  overlay.style.display = "flex";
  await loadNodeAttributes(node.node_id, index_range);
}

export function hideNodeAttributes() {
  document.getElementById("attributes-overlay").style.display = "none";
}

export async function refreshNodeAttributes() {
  const overlay = document.getElementById("attributes-overlay");
  const node_id = overlay.dataset.nodeId;
  if (!node_id) return;
  await loadNodeAttributes(node_id, overlay.dataset.indexRange || null);
}

async function loadNodeAttributes(node_id, index_range = null) {
  const tbody = document.getElementById("attributes-tbody");
  const msgEl = document.getElementById("attributes-write-msg");
  tbody.innerHTML = '<tr><td colspan="2" class="attributes-loading">Loading…</td></tr>';
  msgEl.textContent = "";

  const rangeQuery = index_range ? `&index_range=${encodeURIComponent(index_range)}` : "";
  const res = await apiFetch(`/api/node_attributes?node_id=${encodeURIComponent(node_id)}${rangeQuery}`);
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
  const index_range = overlay.dataset.indexRange || null;
  const title = document.getElementById("attributes-node-name").textContent;
  openValueDetailModal({
    title,
    nodeid: node_id,
    valueRaw: lastAttributesValueRaw,
    plainText: "",
    writable: true,
    onWrite: async (editedValue) => {
      const result = await apiFetch("/api/write_structured", "POST", { node_id, value: editedValue, index_range });
      if (result?.error) {
        appendLog(`Write failed: ${node_id} | ${result.error}`, "error");
      } else {
        appendLog(`Wrote value to ${node_id}: ${result.written_value}`);
        await loadNodeAttributes(node_id, index_range);
      }
      return result;
    },
  });
}

export async function writeAttributeValue() {
  const overlay = document.getElementById("attributes-overlay");
  const node_id = overlay.dataset.nodeId;
  const index_range = overlay.dataset.indexRange || null;
  if (!node_id) return;
  const input = document.getElementById("attributes-write-value");
  if (!input) return;
  const value = input.value;
  const msgEl = document.getElementById("attributes-write-msg");
  msgEl.className = "settings-hint";
  msgEl.textContent = "Writing…";

  const res = await apiFetch("/api/write", "POST", { node_id, value, data_type: "auto", index_range });
  if (res?.error) {
    msgEl.className = "settings-hint attributes-msg-error";
    msgEl.textContent = "Write failed: " + res.error;
    appendLog(`Write failed: ${node_id} | ${res.error}`, "error");
    return;
  }
  msgEl.className = "settings-hint attributes-msg-ok";
  msgEl.textContent = "Write succeeded.";
  appendLog(`Wrote value to ${node_id}: ${res.written_value}`);
  await loadNodeAttributes(node_id, index_range);
}
