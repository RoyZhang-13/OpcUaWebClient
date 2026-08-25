import { apiFetch } from "./api.js";
import { state, clearLogPanel, setConnected, syncDropHint } from "./state.js";
import { initWS } from "./ws.js";
import { loadRootNodes, clearTree } from "./tree.js";
import { initColumnResize } from "./utils.js";
import {
  addMonitoredNodeById,
  removeMonitoredNode,
  clearAllMonitored,
  showValueDetail,
  hideValueDetail,
  writeValueDetail,
} from "./monitor.js";
import { showContextMenu, hideContextMenu } from "./contextmenu.js";
import {
  showAddDialog,
  hideAddDialog,
  confirmAddDialog,
  showSettings,
  hideSettings,
  onIndexRangeToggle,
  applySettings,
  showNodeAttributes,
  hideNodeAttributes,
  refreshNodeAttributes,
  writeAttributeValue,
  viewNodeAttributeValue,
} from "./dialogs.js";

// ─── Connection ─────────────────────────────────────────
async function toggleConnect() {
  const btn = document.getElementById("btn-connect");
  const connected = btn.textContent === "Disconnect";
  if (connected) {
    await apiFetch("/api/disconnect", "POST");
    setConnected(false);
    clearTree();
  } else {
    const url = document.getElementById("server-url").value.trim();
    const username = document.getElementById("username").value.trim() || null;
    const password = document.getElementById("password").value.trim() || null;
    if (!url) return alert("Please enter server URL");
    const res = await apiFetch("/api/connect", "POST", { url, username, password });
    if (res?.status === "connected") {
      setConnected(true);
      initWS();
      loadRootNodes();
    } else {
      alert("Connection failed: " + (res?.message || "Unknown error"));
    }
  }
}

// Expose the handlers still referenced via inline `onclick="..."` in index.html
// and dynamically generated row markup in monitor.js.
window.toggleConnect = toggleConnect;
window.clearLogPanel = clearLogPanel;
window.showAddDialog = showAddDialog;
window.hideAddDialog = hideAddDialog;
window.confirmAddDialog = confirmAddDialog;
window.clearAllMonitored = clearAllMonitored;
window.showSettings = showSettings;
window.applySettings = applySettings;
window.hideSettings = hideSettings;
window.onIndexRangeToggle = onIndexRangeToggle;
window.hideValueDetail = hideValueDetail;
window.writeValueDetail = writeValueDetail;
window.removeMonitoredNode = removeMonitoredNode;
window.showNodeAttributes = showNodeAttributes;
window.hideNodeAttributes = hideNodeAttributes;
window.refreshNodeAttributes = refreshNodeAttributes;
window.writeAttributeValue = writeAttributeValue;
window.viewNodeAttributeValue = viewNodeAttributeValue;

// ─── Init ───────────────────────────────────────────────
(async () => {
  clearLogPanel();

  const status = await apiFetch("/api/status");
  if (status?.connected) {
    setConnected(true);
    initWS();
    loadRootNodes();
  }

  initColumnResize();

  // Left/right panel resize handle
  const handle = document.getElementById("resize-handle");
  const left = document.getElementById("browser-panel");
  let dragging = false;
  let startX = 0;
  let startW = 0;

  handle.addEventListener("mousedown", (e) => {
    dragging = true;
    startX = e.clientX;
    startW = left.getBoundingClientRect().width;
    handle.classList.add("dragging");
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  });

  document.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const delta = e.clientX - startX;
    const newW = Math.max(120, Math.min(startW + delta, window.innerWidth * 0.6));
    left.style.width = newW + "px";
  });

  document.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove("dragging");
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  });

  // Log panel resize handle
  const logPanel = document.getElementById("log-panel");
  const logResizeHandle = document.getElementById("log-resize-handle");
  if (logPanel && logResizeHandle) {
    let resizingLog = false;
    let startY = 0;
    let startHeight = 0;

    logResizeHandle.addEventListener("mousedown", (e) => {
      e.preventDefault();
      resizingLog = true;
      startY = e.clientY;
      startHeight = logPanel.getBoundingClientRect().height;
      logResizeHandle.classList.add("dragging");
      document.body.style.cursor = "ns-resize";
      document.body.style.userSelect = "none";
    });

    document.addEventListener("mousemove", (e) => {
      if (!resizingLog) return;
      const delta = startY - e.clientY;
      const minH = 96;
      const maxH = Math.max(minH, Math.floor(window.innerHeight * 0.5));
      const nextH = Math.max(minH, Math.min(startHeight + delta, maxH));
      logPanel.style.height = `${nextH}px`;
    });

    document.addEventListener("mouseup", () => {
      if (!resizingLog) return;
      resizingLog = false;
      logResizeHandle.classList.remove("dragging");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    });
  }

  // Context menu on monitor panel — detect which row was right-clicked
  document.getElementById("ops-panel").addEventListener("contextmenu", (e) => {
    e.preventDefault();
    const tr = e.target.closest("tr[id^='row-']");
    state.ctxTargetSeq = tr ? parseInt(tr.id.replace("row-", ""), 10) : null;
    state.ctxTargetTreeNode = null;
    const hasRow = state.ctxTargetSeq != null && state.monitored.has(state.ctxTargetSeq);
    document.getElementById("ctx-item-attributes").style.display = hasRow ? "block" : "none";
    document.getElementById("ctx-sep-attributes").style.display = hasRow ? "block" : "none";
    document.getElementById("ctx-item-settings").style.display = hasRow ? "block" : "none";
    document.getElementById("ctx-sep-settings").style.display = hasRow ? "block" : "none";
    document.getElementById("ctx-item-add").style.display = "block";
    document.getElementById("ctx-sep-add").style.display = "block";
    document.getElementById("ctx-item-clear").style.display = "block";
    showContextMenu(e.clientX, e.clientY);
  });
  // Context menu on address space tree — detect which node row was right-clicked
  document.getElementById("browser-panel").addEventListener("contextmenu", (e) => {
    e.preventDefault();
    const row = e.target.closest(".tree-node");
    state.ctxTargetTreeNode = row
      ? { node_id: row.dataset.nodeId, display_name: row.dataset.displayName, node_class: row.dataset.nodeClass }
      : null;
    state.ctxTargetSeq = null;
    const hasNode = !!state.ctxTargetTreeNode;
    if (!hasNode) return; // nothing to show for empty-area right-click
    document.getElementById("ctx-item-attributes").style.display = "block";
    document.getElementById("ctx-sep-attributes").style.display = "none";
    document.getElementById("ctx-item-settings").style.display = "none";
    document.getElementById("ctx-sep-settings").style.display = "none";
    document.getElementById("ctx-item-add").style.display = "none";
    document.getElementById("ctx-sep-add").style.display = "none";
    document.getElementById("ctx-item-clear").style.display = "none";
    showContextMenu(e.clientX, e.clientY);
  });
  // Use capture phase so the menu still hides even when the click target
  // (e.g. a tree row) calls stopPropagation() during the bubble phase.
  document.addEventListener("click", () => hideContextMenu(), true);
  // Prevent context menu click from immediately closing the menu
  document.getElementById("ctx-menu").addEventListener("click", (e) => e.stopPropagation());

  // Dialogs are modal: only the Close/Cancel button dismisses them (Enter still confirms).
  document.getElementById("dialog-node-id").addEventListener("keydown", (e) => {
    if (e.key === "Enter") confirmAddDialog();
  });
  document.getElementById("settings-ir-value").addEventListener("keydown", (e) => {
    if (e.key === "Enter") applySettings();
  });
  // Double-click any monitor row to view full value / array contents
  document.getElementById("monitor-tbody").addEventListener("dblclick", (e) => {
    const tr = e.target.closest("tr");
    if (!tr) return;
    const seq = parseInt(tr.id.replace("row-", ""), 10);
    if (!isNaN(seq)) showValueDetail(seq);
  });

  // Drag-and-drop onto monitor table
  const dropZone = document.getElementById("monitor-drop-zone");
  dropZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    dropZone.classList.add("drag-over");
  });
  dropZone.addEventListener("dragleave", (e) => {
    if (!dropZone.contains(e.relatedTarget)) dropZone.classList.remove("drag-over");
  });
  dropZone.addEventListener("drop", async (e) => {
    e.preventDefault();
    dropZone.classList.remove("drag-over");
    try {
      const ids = JSON.parse(e.dataTransfer.getData("application/json"));
      for (const id of ids) await addMonitoredNodeById(id);
    } catch {
      // Ignore malformed drag payloads.
    }
  });

  // Show hint initially
  syncDropHint();
})();
