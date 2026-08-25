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

export function flattenArrayEntries(value, displayPrefix = [], objPath = []) {
  const entries = [];
  const indexText = displayPrefix.join("") || "[]";

  if (value == null) {
    entries.push({ kind: "scalar", index: indexText, value: "null" });
    return entries;
  }

  if (value && value._type === "scalar") {
    const scalarText = String(value.value ?? "");
    const parsed = parseStructLikeString(scalarText);
    if (parsed) {
      entries.push({ kind: "struct-header", index: indexText, value: parsed.label });
      for (const field of parsed.fields) {
        entries.push({ kind: "struct-field", index: field.key, value: field.value });
      }
      return entries;
    }
    entries.push({ kind: "scalar", index: indexText, value: scalarText, path: objPath });
    return entries;
  }

  if (value && value._type === "struct") {
    const fields = value.fields || {};
    const editableStruct = value.editable !== false;
    entries.push({ kind: "struct-header", index: indexText, value: value._label || "Struct" });
    for (const [key, inner] of Object.entries(fields)) {
      if (inner == null) {
        entries.push({ kind: "struct-field", index: key, value: "null" });
        continue;
      }
      if (inner && inner._type === "scalar") {
        entries.push({
          kind: "struct-field",
          index: key,
          value: String(inner.value ?? ""),
          path: editableStruct ? [...objPath, key] : undefined,
        });
        continue;
      }
      entries.push({ kind: "struct-field", index: key, value: formatArrayDisplay(inner) });
    }
    return entries;
  }

  if (Array.isArray(value)) {
    value.forEach((item, idx) => {
      const nextDisplayPrefix = [...displayPrefix, `[${idx}]`];
      const nextObjPath = [...objPath, idx];
      if (item == null) {
        entries.push({ kind: "scalar", index: nextDisplayPrefix.join(""), value: "null" });
        return;
      }
      if (item && item._type === "scalar") {
        const scalarText = String(item.value ?? "");
        const parsed = parseStructLikeString(scalarText);
        if (parsed) {
          entries.push({ kind: "struct-header", index: nextDisplayPrefix.join(""), value: parsed.label });
          for (const field of parsed.fields) {
            entries.push({ kind: "struct-field", index: field.key, value: field.value });
          }
          return;
        }
      }
      entries.push(...flattenArrayEntries(item, nextDisplayPrefix, nextObjPath));
    });
    return entries;
  }

  entries.push({ kind: "scalar", index: indexText, value: String(value) });
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

  if (kind === "struct-header") {
    return `<tr class="array-elem-hdr"><td class="array-idx array-idx-elem">${idxHtml}</td><td class="array-val array-struct-label">${valHtml}</td></tr>`;
  }

  if (kind === "struct-field") {
    if (canEditThis) {
      return `<tr class="array-field-row"><td class="array-idx array-field-name">${idxHtml}</td><td class="array-val array-field-val"><input type="text" class="array-val-input dialog-input"${pathAttr} value="${valHtml}" /></td></tr>`;
    }
    return `<tr class="array-field-row"><td class="array-idx array-field-name">${idxHtml}</td><td class="array-val array-field-val">${valHtml}</td></tr>`;
  }

  if (canEditThis) {
    return `<tr class="array-elem-hdr"><td class="array-idx array-idx-elem">${idxHtml}</td><td class="array-val"><input type="text" class="array-val-input dialog-input"${pathAttr} value="${valHtml}" /></td></tr>`;
  }
  return `<tr class="array-elem-hdr"><td class="array-idx array-idx-elem">${idxHtml}</td><td class="array-val">${valHtml}</td></tr>`;
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
