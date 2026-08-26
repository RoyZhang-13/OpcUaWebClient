// ─── Pure helper functions (no shared state) ───────────

export function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function formatArrayDisplay(value) {
  if (value == null) return "null";
  if (value && value._type === "scalar") return String(value.value ?? "");
  if (value && value._type === "struct") {
    if (value.fields) {
      const parts = Object.entries(value.fields).map(([key, inner]) => `${key}: ${formatArrayDisplay(inner)}`);
      return `{${parts.join(", ")}}`;
    }
    return value._label || "{}";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => formatArrayDisplay(item)).join(", ")}]`;
  }
  return String(value);
}

export function splitTopLevel(text, delimiterChar) {
  const parts = [];
  let current = "";
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const prev = i > 0 ? text[i - 1] : "";

    if (ch === "'" && !inDoubleQuote && prev !== "\\") {
      inSingleQuote = !inSingleQuote;
    } else if (ch === '"' && !inSingleQuote && prev !== "\\") {
      inDoubleQuote = !inDoubleQuote;
    } else if (!inSingleQuote && !inDoubleQuote) {
      if (ch === "(") parenDepth++;
      if (ch === ")") parenDepth = Math.max(0, parenDepth - 1);
      if (ch === "[") bracketDepth++;
      if (ch === "]") bracketDepth = Math.max(0, bracketDepth - 1);
      if (ch === "{") braceDepth++;
      if (ch === "}") braceDepth = Math.max(0, braceDepth - 1);

      if (ch === delimiterChar && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
        const piece = current.trim();
        if (piece) parts.push(piece);
        current = "";
        continue;
      }
    }

    current += ch;
  }

  const tail = current.trim();
  if (tail) parts.push(tail);
  return parts;
}

export function splitTopLevelAssignment(text) {
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const prev = i > 0 ? text[i - 1] : "";

    if (ch === "'" && !inDoubleQuote && prev !== "\\") {
      inSingleQuote = !inSingleQuote;
      continue;
    }
    if (ch === '"' && !inSingleQuote && prev !== "\\") {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }
    if (inSingleQuote || inDoubleQuote) continue;

    if (ch === "(") parenDepth++;
    else if (ch === ")") parenDepth = Math.max(0, parenDepth - 1);
    else if (ch === "[") bracketDepth++;
    else if (ch === "]") bracketDepth = Math.max(0, bracketDepth - 1);
    else if (ch === "{") braceDepth++;
    else if (ch === "}") braceDepth = Math.max(0, braceDepth - 1);

    if (ch === "=" && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
      return {
        key: text.slice(0, i).trim(),
        value: text.slice(i + 1).trim(),
      };
    }
  }

  return null;
}

export function parseStructLikeString(text) {
  const raw = String(text ?? "").trim();
  const match = raw.match(/^([A-Za-z_]\w*)\((.*)\)$/s);
  if (!match) return null;

  const label = match[1];
  const body = match[2].trim();
  if (!body) return { label, fields: [] };

  const parts = splitTopLevel(body, ",");
  const fields = [];
  for (const part of parts) {
    const kv = splitTopLevelAssignment(part);
    if (!kv || !kv.key) return null;
    fields.push(kv);
  }
  if (fields.length === 0) return null;
  return { label, fields };
}

export function flattenArrayEntries(value, displayPrefix = [], objPath = [], depth = 0, ancestors = []) {
  const entries = [];
  const indexText = displayPrefix.join("") || "[]";
  const rowId = JSON.stringify(objPath.length ? objPath : ["__root__", displayPrefix.join("")]);

  if (value == null) {
    entries.push({ kind: "scalar", index: indexText, value: "null", depth, ancestors });
    return entries;
  }

  if (value && value._type === "scalar") {
    const scalarText = String(value.value ?? "");
    const parsed = parseStructLikeString(scalarText);
    if (parsed) {
      entries.push({
        kind: "struct-header",
        index: indexText,
        value: parsed.label,
        depth,
        ancestors,
        id: rowId,
        expandable: parsed.fields.length > 0,
      });
      const childAncestors = [...ancestors, rowId];
      for (const field of parsed.fields) {
        entries.push({ kind: "struct-field", index: field.key, value: field.value, depth: depth + 1, ancestors: childAncestors });
      }
      return entries;
    }
    entries.push({ kind: "scalar", index: indexText, value: scalarText, path: objPath, depth, ancestors });
    return entries;
  }

  if (value && value._type === "struct") {
    const fields = value.fields || {};
    const editableStruct = value.editable !== false;
    const fieldEntries = Object.entries(fields);
    entries.push({
      kind: "struct-header",
      index: indexText,
      value: value._label || "Struct",
      depth,
      ancestors,
      id: rowId,
      expandable: fieldEntries.length > 0,
    });
    const childAncestors = [...ancestors, rowId];
    for (const [key, inner] of fieldEntries) {
      if (inner == null) {
        entries.push({ kind: "struct-field", index: key, value: "null", depth: depth + 1, ancestors: childAncestors });
        continue;
      }
      if (inner && inner._type === "scalar") {
        const fieldEditable = editableStruct && inner.editable !== false;
        entries.push({
          kind: "struct-field",
          index: key,
          value: String(inner.value ?? ""),
          path: fieldEditable ? [...objPath, key] : undefined,
          depth: depth + 1,
          ancestors: childAncestors,
        });
        continue;
      }
      // Nested struct or array fields (e.g. ServerStatusDataType.BuildInfo,
      // ShutdownReason: LocalizedText) are recursed into their own
      // hierarchical, independently collapsible rows (one indent level
      // deeper) instead of being collapsed into a flattened
      // "{key: value, ...}" text blob.
      entries.push(...flattenArrayEntries(inner, [key], [...objPath, key], depth + 1, childAncestors));
    }
    return entries;
  }

  if (Array.isArray(value)) {
    value.forEach((item, idx) => {
      const nextDisplayPrefix = [...displayPrefix, `[${idx}]`];
      const nextObjPath = [...objPath, idx];
      if (item == null) {
        entries.push({ kind: "scalar", index: nextDisplayPrefix.join(""), value: "null", depth, ancestors });
        return;
      }
      if (item && item._type === "scalar") {
        const scalarText = String(item.value ?? "");
        const parsed = parseStructLikeString(scalarText);
        if (parsed) {
          const itemId = JSON.stringify(nextObjPath);
          entries.push({
            kind: "struct-header",
            index: nextDisplayPrefix.join(""),
            value: parsed.label,
            depth,
            ancestors,
            id: itemId,
            expandable: parsed.fields.length > 0,
          });
          const childAncestors = [...ancestors, itemId];
          for (const field of parsed.fields) {
            entries.push({ kind: "struct-field", index: field.key, value: field.value, depth: depth + 1, ancestors: childAncestors });
          }
          return;
        }
      }
      // Array dimensions/elements stay at the same depth — they're already
      // distinguished via the bracket index text (e.g. "[0][0][0]") rather
      // than needing their own indent level. Struct elements still get their
      // own collapsible header (handled by the recursive call below).
      entries.push(...flattenArrayEntries(item, nextDisplayPrefix, nextObjPath, depth, ancestors));
    });
    return entries;
  }

  entries.push({ kind: "scalar", index: indexText, value: String(value), depth, ancestors });
  return entries;
}

function structIsEditable(node) {
  return !!node && node._type === "struct" && node.editable !== false;
}

// Recursively checks a single element, which may itself be a nested array
// (for multi-dimensional array values — asyncua reshapes 2D/3D arrays into
// nested lists rather than a single flat list).
function isEditableArrayElement(item) {
  if (item == null) return true;
  if (Array.isArray(item)) {
    if (item.length === 0) return true;
    return item.every(isEditableArrayElement);
  }
  if (item._type === "scalar") return parseStructLikeString(String(item.value ?? "")) === null;
  if (item._type === "struct") return structIsEditable(item);
  return false;
}

export function isEditableValue(valueRaw) {
  if (Array.isArray(valueRaw)) {
    if (valueRaw.length === 0) return false;
    return valueRaw.every(isEditableArrayElement);
  }
  if (valueRaw && valueRaw._type === "struct") return structIsEditable(valueRaw);
  return false;
}

export function renderArrayEntryRow(entry, editable = false) {
  const kind = entry?.kind || "scalar";
  const idxHtml = escapeHtml(entry?.index || "[]");
  const valHtml = escapeHtml(entry?.value ?? "");
  const canEditThis = editable && entry?.path !== undefined;
  const pathAttr = canEditThis ? ` data-path='${escapeHtml(JSON.stringify(entry.path))}'` : "";

  // Tree presentation: each level of nesting (struct-in-struct, or a
  // struct-typed array element) gets a vertical guide line connecting it to
  // its parent, plus a collapse/expand toggle when the row has children.
  const depth = entry?.depth || 0;
  const ancestors = entry?.ancestors || [];
  const rowAttrs = ` data-depth="${depth}" data-ancestors='${escapeHtml(JSON.stringify(ancestors))}'`;
  const guides = Array.from({ length: depth }, () => `<span class="tree-guide"></span>`).join("");
  const toggleHtml = entry?.expandable
    ? `<span class="tree-toggle" data-toggle-id="${escapeHtml(entry.id || "")}">&#9660;</span>`
    : `<span class="tree-toggle-spacer"></span>`;
  const nameCell = `<span class="tree-indent">${guides}${toggleHtml}</span><span class="tree-label">${idxHtml}</span>`;

  if (kind === "struct-header") {
    return `<tr class="array-elem-hdr"${rowAttrs}><td class="array-idx array-idx-elem array-tree-cell">${nameCell}</td><td class="array-val array-struct-label">${valHtml}</td></tr>`;
  }

  if (kind === "struct-field") {
    if (canEditThis) {
      return `<tr class="array-field-row"${rowAttrs}><td class="array-idx array-field-name array-tree-cell">${nameCell}</td><td class="array-val array-field-val"><input type="text" class="array-val-input dialog-input"${pathAttr} value="${valHtml}" /></td></tr>`;
    }
    return `<tr class="array-field-row"${rowAttrs}><td class="array-idx array-field-name array-tree-cell">${nameCell}</td><td class="array-val array-field-val">${valHtml}</td></tr>`;
  }

  if (canEditThis) {
    return `<tr class="array-elem-hdr"${rowAttrs}><td class="array-idx array-idx-elem array-tree-cell">${nameCell}</td><td class="array-val"><input type="text" class="array-val-input dialog-input"${pathAttr} value="${valHtml}" /></td></tr>`;
  }
  return `<tr class="array-elem-hdr"${rowAttrs}><td class="array-idx array-idx-elem array-tree-cell">${nameCell}</td><td class="array-val">${valHtml}</td></tr>`;
}

// Wires up collapse/expand behavior for the tree toggles rendered by
// `renderArrayEntryRow`. A row is hidden whenever any of its ancestor struct
// ids are in the (locally-tracked) collapsed set, so nested collapse/expand
// combinations resolve correctly regardless of click order.
export function bindArrayTreeToggle(table) {
  if (!table) return;
  const collapsed = new Set();

  function applyVisibility() {
    const rows = Array.from(table.querySelectorAll("tbody tr[data-ancestors]"));
    for (const row of rows) {
      let ancestors = [];
      try {
        ancestors = JSON.parse(row.dataset.ancestors || "[]");
      } catch {
        ancestors = [];
      }
      const hidden = ancestors.some((id) => collapsed.has(id));
      row.classList.toggle("tree-row-hidden", hidden);
    }
  }

  const toggles = Array.from(table.querySelectorAll(".tree-toggle[data-toggle-id]"));
  for (const toggle of toggles) {
    toggle.addEventListener("click", () => {
      const id = toggle.dataset.toggleId;
      if (!id) return;
      if (collapsed.has(id)) {
        collapsed.delete(id);
        toggle.classList.remove("tree-toggle-collapsed");
      } else {
        collapsed.add(id);
        toggle.classList.add("tree-toggle-collapsed");
      }
      applyVisibility();
    });
  }
}

export function bindTableColumnResize(table) {
  if (!table) return;
  const ths = Array.from(table.querySelectorAll("thead th"));
  ths.forEach((th, i) => {
    if (i === ths.length - 1) return;
    if (th.querySelector(".col-resize-handle")) return;
    const handle = document.createElement("div");
    handle.className = "col-resize-handle";
    th.style.position = "relative";
    th.appendChild(handle);
    handle.addEventListener("mousedown", (e) => {
      e.stopPropagation();
      const startX = e.clientX;
      const startW = th.offsetWidth;
      handle.classList.add("col-dragging");
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      const onMove = (e) => {
        th.style.width = Math.max(40, startW + (e.clientX - startX)) + "px";
      };
      const onUp = () => {
        handle.classList.remove("col-dragging");
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  });
}

export function initColumnResize() {
  bindTableColumnResize(document.getElementById("monitor-table"));
}

// ─── Draggable dialogs ──────────────────────────────────
// Makes every `.dialog-box` draggable by its `.dialog-title` header. Position
// is only switched from the default flex-centered layout to `fixed` once the
// user starts dragging, so dialogs still open centered by default.
export function initDraggableDialogs() {
  document.querySelectorAll(".dialog-box").forEach((box) => {
    const handle = box.querySelector(".dialog-title");
    if (!handle || handle.dataset.dragInit) return;
    handle.dataset.dragInit = "1";

    let dragging = false;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;

    handle.addEventListener("mousedown", (e) => {
      if (e.target.closest(".dialog-close-btn")) return;
      const rect = box.getBoundingClientRect();
      box.style.position = "fixed";
      box.style.margin = "0";
      box.style.left = rect.left + "px";
      box.style.top = rect.top + "px";
      startLeft = rect.left;
      startTop = rect.top;
      startX = e.clientX;
      startY = e.clientY;
      dragging = true;
      document.body.style.userSelect = "none";
      e.preventDefault();
    });

    document.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      const maxLeft = window.innerWidth - 60;
      const maxTop = window.innerHeight - 30;
      box.style.left = Math.min(Math.max(startLeft + dx, -box.offsetWidth + 80), maxLeft) + "px";
      box.style.top = Math.min(Math.max(startTop + dy, 0), maxTop) + "px";
    });

    document.addEventListener("mouseup", () => {
      if (!dragging) return;
      dragging = false;
      document.body.style.userSelect = "";
    });
  });
}
