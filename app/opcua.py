from __future__ import annotations

import json
import logging
import os
import re
import sys
from typing import Any, Optional

from asyncua import Client, ua
from asyncua.common.node import Node
from fastapi import WebSocket

from app.state import state

logger = logging.getLogger(__name__)


def _res(relative: str) -> str:
    base = getattr(sys, "_MEIPASS", os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    return os.path.join(base, relative)


class SharedSubHandler:
    """Single handler attached to the shared subscription."""

    async def datachange_notification(self, node: Node, val: Any, data: Any):
        client_handle = data.monitored_item.ClientHandle
        seq = state.client_handle_to_seq.get(client_handle)
        if seq is None:
            return
        entry = state.subscriptions.get(seq, {})
        node_id = entry.get("node_id", node.nodeid.to_string())
        display_name = entry.get("display_name", "")
        dv = data.monitored_item.Value
        data_type: Optional[str] = None
        try:
            data_type = await _resolve_data_type_name(node, val)
        except Exception:
            pass
        if not data_type:
            try:
                vt = dv.Value.VariantType
                if isinstance(vt, int):
                    vt = ua.VariantType(vt)
                data_type = vt.name
            except Exception:
                pass
        status_code: Optional[str] = None
        try:
            sc = dv.StatusCode
            if isinstance(sc, int):
                sc = ua.StatusCode(sc)
            status_code = f"{sc.name} (0x{sc.value:08X})"
        except Exception:
            pass
        src_ts: Optional[str] = None
        try:
            v = _fmt_ts(dv.SourceTimestamp)
            if v:
                src_ts = v
        except Exception:
            pass
        srv_ts: Optional[str] = None
        try:
            v = _fmt_ts(dv.ServerTimestamp)
            if v:
                srv_ts = v
        except Exception:
            pass
        message = json.dumps({
            "type": "datachange",
            "seq": seq,
            "node_id": node_id,
            "display_name": display_name,
            "value": _safe_value_repr(val),
            "value_raw": _serialize_value(val) if isinstance(val, (list, tuple)) else None,
            "data_type": data_type,
            "source_timestamp": src_ts,
            "server_timestamp": srv_ts,
            "status_code": status_code,
        })
        await _broadcast(message)

    def event_notification(self, event: Any):
        return None


_shared_handler = SharedSubHandler()


async def _broadcast(message: str):
    dead: list[WebSocket] = []
    for ws in state.active_websockets:
        try:
            await ws.send_text(message)
        except Exception:
            dead.append(ws)
    for ws in dead:
        if ws in state.active_websockets:
            state.active_websockets.remove(ws)


def _deserialize_extension_object(v: ua.ExtensionObject):
    try:
        type_id = getattr(v, "TypeId", None)
        body = getattr(v, "Body", None)
        if type_id is None or body is None:
            return None
        cls = ua.extension_objects_by_typeid.get(type_id)
        if cls is None:
            return None
        try:
            return ua.from_binary(cls, ua.Buffer(body))
        except Exception:
            pass
    except Exception:
        pass
    return None


def _serialize_element(v: Any) -> dict:
    if v is None:
        return {"_type": "scalar", "value": "null"}
    if isinstance(v, bool):
        return {"_type": "scalar", "value": str(v)}
    if isinstance(v, (int, float, str)):
        return {"_type": "scalar", "value": str(v)}
    if isinstance(v, (bytes, bytearray)):
        return {"_type": "scalar", "value": v.hex() if isinstance(v, (bytes, bytearray)) else str(v)}
    try:
        if isinstance(v, ua.ExtensionObject):
            decoded = _deserialize_extension_object(v)
            if decoded is not None:
                return _serialize_element(decoded)
            return {"_type": "struct", "_label": "ExtensionObject", "fields": {
                "TypeId": str(getattr(v, "TypeId", "")),
                "Body": str(getattr(v, "Body", "")),
            }}
    except Exception:
        pass
    try:
        if isinstance(v, ua.NodeId):
            ntype_val = v.NodeIdType.value if hasattr(v.NodeIdType, "value") else int(v.NodeIdType)
            if ntype_val in (0, 1, 2):
                id_type, id_key = "0 (Numeric)", "Numeric"
                id_val = str(v.Identifier)
            elif ntype_val == 3:
                id_type, id_key = "1 (String)", "String"
                id_val = str(v.Identifier)
            elif ntype_val == 4:
                id_type, id_key = "2 (Guid)", "Guid"
                id_val = "{" + str(v.Identifier) + "}"
            else:
                id_type, id_key = "3 (Opaque)", "Opaque"
                raw = v.Identifier
                id_val = raw.hex().upper() if isinstance(raw, (bytes, bytearray)) else str(raw)
            return {"_type": "struct", "_label": "NodeId", "fields": {
                "NamespaceIndex": str(v.NamespaceIndex),
                "IdentifierType": id_type,
                id_key: id_val,
            }}
    except Exception:
        pass
    try:
        if isinstance(v, ua.QualifiedName):
            return {"_type": "struct", "_label": "QualifiedName", "fields": {
                "NamespaceIndex": str(v.NamespaceIndex),
                "Name": str(v.Name or ""),
            }}
    except Exception:
        pass
    try:
        if isinstance(v, ua.LocalizedText):
            return {"_type": "struct", "_label": "LocalizedText", "fields": {
                "Locale": str(v.Locale or ""),
                "Text": str(v.Text or ""),
            }}
    except Exception:
        pass
    if hasattr(v, "__dict__") and not isinstance(v, type):
        fields = {}
        for k, fv in vars(v).items():
            if k.startswith("_"):
                continue
            fields[k] = _serialize_value(fv)
        return {"_type": "struct", "_label": type(v).__name__, "fields": fields}
    return {"_type": "scalar", "value": str(v)}


def _serialize_value(v: Any):
    if isinstance(v, (list, tuple)):
        return [_serialize_value(item) for item in v]
    return _serialize_element(v)


def _safe_value_repr(v: Any) -> str:
    if v is None:
        return "null"
    if isinstance(v, (list, tuple)):
        return "[" + ", ".join(_safe_value_repr(item) for item in v) + "]"
    if isinstance(v, bool):
        return str(v).lower()
    if isinstance(v, (int, float, str)):
        return str(v)
    if isinstance(v, ua.ExtensionObject):
        type_name = "ExtensionObject"
        try:
            type_name = v.TypeId.to_string()
        except Exception:
            pass
        body = getattr(v, "Body", None)
        if body is not None and hasattr(body, "__dict__"):
            try:
                fields = vars(body)
                return f"{type_name}({', '.join(f'{k}={_safe_value_repr(val)}' for k, val in fields.items() if not k.startswith('_'))})"
            except Exception:
                pass
        return f"{type_name}({body!r})"
    if hasattr(v, "__dict__") and not isinstance(v, type):
        items = []
        try:
            for k, fv in vars(v).items():
                if not k.startswith("_"):
                    items.append(f"{k}={_safe_value_repr(fv)}")
            if items:
                return f"{type(v).__name__}({', '.join(items)})"
        except Exception:
            pass
    try:
        return str(v)
    except Exception:
        return type(v).__name__


async def _resolve_data_type_name(node: Optional[Node] = None, value: Any = None, fallback: str = "") -> str:
    if node is not None:
        try:
            dt = await node.read_data_type()
            if dt is not None:
                try:
                    dt_node = state.client.get_node(dt)
                    bn = await dt_node.read_browse_name()
                    if bn and getattr(bn, "Name", None):
                        return bn.Name
                except Exception:
                    pass
                try:
                    return dt.to_string()
                except Exception:
                    return str(dt)
        except Exception:
            pass
    try:
        vt = getattr(value, "VariantType", None)
        if vt is not None:
            if isinstance(vt, int):
                vt = ua.VariantType(vt)
            return vt.name
    except Exception:
        pass
    if isinstance(value, (list, tuple)) and value:
        first = value[0]
        return _resolve_data_type_name(node=None, value=first, fallback=fallback)
    return fallback


def _fmt_ts(ts: Any) -> str:
    if ts is None:
        return ""
    try:
        return ts.strftime("%m/%d/%y %H:%M:%S.%f") if hasattr(ts, "strftime") else str(ts)
    except Exception:
        return str(ts)


def _status_code_from_error_text(msg: str) -> str:
    text = str(msg or "").strip()
    if not text:
        return ""
    m = re.search(r"\bEnumStatusCode_[A-Za-z0-9_]+\b", text)
    if m:
        return m.group(0)
    m = re.search(r"\(([A-Za-z][A-Za-z0-9_]+)\)\s*$", text)
    if m and m.group(1).startswith(("Bad", "Good", "Uncertain")):
        return m.group(1)
    m = re.search(r"\b(Bad|Good|Uncertain)[A-Za-z0-9_]+\b", text)
    if m:
        return m.group(0)
    return ""


async def _get_node(node_id: str) -> Node:
    assert state.client is not None
    return state.client.get_node(node_id)


async def _browse_children(node: Node) -> list[dict]:
    children = []
    try:
        refs = await node.get_children_descriptions(refs=ua.ObjectIds.HierarchicalReferences)
        for ref in refs:
            children.append({
                "node_id": ref.NodeId.to_string(),
                "browse_name": f"{ref.BrowseName.NamespaceIndex}:{ref.BrowseName.Name}",
                "display_name": ref.DisplayName.Text,
                "node_class": ref.NodeClass.name,
            })
    except Exception as e:
        logger.warning("browse failed: %s", e)
    return children


async def reset_connection_state():
    if state.client and state.connected:
        try:
            await state.client.disconnect()
        except Exception:
            pass
    state.client = None
    state.connected = False
    state.subscriptions.clear()
    state.client_handle_to_seq.clear()
    state.shared_sub = None


__all__ = [
    "Client",
    "Node",
    "SharedSubHandler",
    "_broadcast",
    "_browse_children",
    "_fmt_ts",
    "_get_node",
    "_res",
    "_resolve_data_type_name",
    "_safe_value_repr",
    "_serialize_value",
    "_status_code_from_error_text",
    "_shared_handler",
    "reset_connection_state",
]
