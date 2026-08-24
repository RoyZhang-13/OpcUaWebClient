import { apiFetch } from "./api.js";
import { state } from "./state.js";

// ─── Node Tree ─────────────────────────────────────────
const CLASS_ICONS = {
  Object: "📁",
  Variable: "🔢",
  Method: "⚙️",
  ObjectType: "🗂️",
  VariableType: "📋",
  ReferenceType: "🔗",
  DataType: "📐",
  View: "👁️",
};

export async function loadRootNodes() {
  const root = document.getElementById("node-tree");
  root.innerHTML = '<span style="color:#9ca3af;font-size:12px">Loading…</span>';
  const data = await apiFetch("/api/browse?node_id=i%3D84");
  if (data?.error) {
    root.innerHTML = `<span style="color:#c0392b">${data.error}</span>`;
    return;
  }
  root.innerHTML = "";
  for (const child of data.children || []) {
    root.appendChild(buildTreeNode(child, 0));
  }
}

export function clearTree() {
  document.getElementById("node-tree").innerHTML = "";
}

export function buildTreeNode(info, depth) {
  const wrapper = document.createElement("div");

  const row = document.createElement("div");
  row.className = "tree-node";
  row.dataset.nodeId = info.node_id;
  row.dataset.expanded = "false";

  const expandIcon = document.createElement("span");
  expandIcon.className = "expand-icon";
  expandIcon.textContent = "▶";

  const icon = document.createElement("span");
  icon.className = "node-icon";
  icon.textContent = CLASS_ICONS[info.node_class] || "•";

  const label = document.createElement("span");
  label.className = "node-label";
  label.textContent = info.display_name || info.browse_name;

  const idBadge = document.createElement("span");
  idBadge.className = "node-id-badge";
  idBadge.textContent = info.node_id;
  idBadge.title = info.node_id;

  row.appendChild(expandIcon);
  row.appendChild(icon);
  row.appendChild(label);
  row.appendChild(idBadge);

  const childrenDiv = document.createElement("div");
  childrenDiv.className = "tree-children";
  childrenDiv.style.display = "none";

  row.addEventListener("click", async (e) => {
    e.stopPropagation();
    // Ctrl/Meta: toggle single node, update anchor
    if (e.ctrlKey || e.metaKey) {
      if (state.selectedTreeNodes.has(info.node_id)) {
        state.selectedTreeNodes.delete(info.node_id);
        row.classList.remove("selected");
      } else {
        state.selectedTreeNodes.set(info.node_id, info);
        row.classList.add("selected");
        state.anchorTreeRow = row;
      }
      return;
    }
    // Shift: range select in DOM order between anchor and this row
    if (e.shiftKey && state.anchorTreeRow) {
      const allRows = Array.from(document.querySelectorAll(".tree-node"));
      const ai = allRows.indexOf(state.anchorTreeRow);
      const ci = allRows.indexOf(row);
      if (ai !== -1 && ci !== -1) {
        document.querySelectorAll(".tree-node.selected").forEach((el) => el.classList.remove("selected"));
        state.selectedTreeNodes.clear();
        const [s, end] = ai <= ci ? [ai, ci] : [ci, ai];
        for (let i = s; i <= end; i++) {
          const r = allRows[i];
          r.classList.add("selected");
          state.selectedTreeNodes.set(r.dataset.nodeId, { node_id: r.dataset.nodeId });
        }
      }
      return;
    }
    // Plain click: clear selection, select this, set anchor, then expand/collapse
    document.querySelectorAll(".tree-node.selected").forEach((el) => el.classList.remove("selected"));
    state.selectedTreeNodes.clear();
    state.selectedTreeNodes.set(info.node_id, info);
    row.classList.add("selected");
    state.anchorTreeRow = row;

    if (row.dataset.expanded === "true") {
      row.dataset.expanded = "false";
      expandIcon.textContent = "▶";
      childrenDiv.style.display = "none";
      return;
    }

    expandIcon.textContent = "⋯";
    const data = await apiFetch(`/api/browse?node_id=${encodeURIComponent(info.node_id)}`);
    childrenDiv.innerHTML = "";
    if (data?.children?.length) {
      for (const child of data.children) {
        childrenDiv.appendChild(buildTreeNode(child));
      }
      expandIcon.textContent = "▼";
    } else {
      expandIcon.textContent = "·";
    }
    row.dataset.expanded = "true";
    childrenDiv.style.display = "block";
  });

  // Drag to monitor table — drag all selected nodes, or just this one
  row.draggable = true;
  row.addEventListener("dragstart", (e) => {
    e.stopPropagation();
    const ids = state.selectedTreeNodes.has(info.node_id)
      ? Array.from(state.selectedTreeNodes.keys())
      : [info.node_id];
    e.dataTransfer.setData("application/json", JSON.stringify(ids));
    e.dataTransfer.effectAllowed = "copy";
  });

  wrapper.appendChild(row);
  wrapper.appendChild(childrenDiv);
  return wrapper;
}
