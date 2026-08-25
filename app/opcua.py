from __future__ import annotations

import copy
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
            "value_raw": _serialize_value(val) if isinstance(val, (list, tuple)) or _is_complex_value(val) else None,
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
            return {"_type": "struct", "_label": "ExtensionObject", "editable": False, "fields": {
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
            # NodeId fields don't map 1:1 to real attribute names (IdentifierType
            # is synthetic, and the id_key varies), so round-tripping edits isn't
            # safe — keep this struct read-only.
            return {"_type": "struct", "_label": "NodeId", "editable": False, "fields": {
                "NamespaceIndex": {"_type": "scalar", "value": str(v.NamespaceIndex)},
                "IdentifierType": {"_type": "scalar", "value": id_type},
                id_key: {"_type": "scalar", "value": id_val},
            }}
    except Exception:
        pass
    try:
        if isinstance(v, ua.QualifiedName):
            return {"_type": "struct", "_label": "QualifiedName", "editable": True, "fields": {
                "NamespaceIndex": {"_type": "scalar", "value": str(v.NamespaceIndex)},
                "Name": {"_type": "scalar", "value": str(v.Name or "")},
            }}
    except Exception:
        pass
    try:
        if isinstance(v, ua.LocalizedText):
            return {"_type": "struct", "_label": "LocalizedText", "editable": True, "fields": {
                "Locale": {"_type": "scalar", "value": str(v.Locale or "")},
                "Text": {"_type": "scalar", "value": str(v.Text or "")},
            }}
    except Exception:
        pass
    if hasattr(v, "__dict__") and not isinstance(v, type):
        fields = {}
        for k, fv in vars(v).items():
            if k.startswith("_"):
                continue
            fields[k] = _serialize_value(fv)
        return {"_type": "struct", "_label": type(v).__name__, "editable": True, "fields": fields}
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


async def _create_monitored_item_with_timestamps(
    sub, mir: ua.MonitoredItemCreateRequest, timestamps_to_return: str
) -> int | ua.StatusCode:
    """
    Low-level replacement for `Subscription.create_monitored_items()` that allows
    overriding `TimestampsToReturn` (hardcoded to `Both` in asyncua's high-level
    helper). Replicates that method's internal bookkeeping so notification
    routing and unsubscribe keep working normally.
    """
    from asyncua.common.subscription import SubscriptionItemData

    try:
        ts = ua.TimestampsToReturn[timestamps_to_return]
    except KeyError:
        ts = ua.TimestampsToReturn.Both

    params = ua.CreateMonitoredItemsParameters()
    params.SubscriptionId = sub.subscription_id
    params.ItemsToCreate = [mir]
    params.TimestampsToReturn = ts

    data = SubscriptionItemData()
    data.client_handle = mir.RequestedParameters.ClientHandle
    data.node = Node(sub.server, mir.ItemToMonitor.NodeId)
    data.attribute = mir.ItemToMonitor.AttributeId
    data.mfilter = mir.RequestedParameters.Filter
    data.queuesize = mir.RequestedParameters.QueueSize
    data.monitoring_mode = mir.MonitoringMode
    data.sampling_interval = mir.RequestedParameters.SamplingInterval
    sub._monitored_items[mir.RequestedParameters.ClientHandle] = data

    results = await sub.server.create_monitored_items(params)
    result = results[0]
    if not result.StatusCode.is_good():
        del sub._monitored_items[mir.RequestedParameters.ClientHandle]
        return result.StatusCode
    data.server_handle = result.MonitoredItemId
    return result.MonitoredItemId


async def _modify_monitored_item_full(
    sub,
    server_handle: int,
    client_handle: int,
    sampling_interval: float,
    queue_size: int,
    discard_oldest: bool,
) -> ua.MonitoredItemModifyResult:
    """
    Low-level replacement for `Subscription.modify_monitored_item()` that also
    allows overriding `DiscardOldest` (not exposed by asyncua's high-level helper).
    """
    mparams = ua.MonitoringParameters()
    mparams.ClientHandle = client_handle
    mparams.SamplingInterval = sampling_interval
    mparams.QueueSize = queue_size
    mparams.DiscardOldest = discard_oldest
    item = sub._monitored_items.get(client_handle)
    if item is not None:
        mparams.Filter = item.mfilter

    modif_item = ua.MonitoredItemModifyRequest()
    modif_item.MonitoredItemId = server_handle
    modif_item.RequestedParameters = mparams

    params = ua.ModifyMonitoredItemsParameters()
    params.SubscriptionId = sub.subscription_id
    params.ItemsToModify = [modif_item]

    results = await sub.server.modify_monitored_items(params)
    result = results[0]
    if result.StatusCode.is_good() and item is not None:
        item.sampling_interval = sampling_interval
        item.queuesize = queue_size
    return result


async def _set_monitoring_mode_for_item(sub, server_handle: int, mode: str) -> ua.StatusCode:
    """Set the monitoring mode for a single monitored item (not the whole subscription)."""
    monitoring_mode = ua.MonitoringMode[mode]
    params = ua.SetMonitoringModeParameters()
    params.SubscriptionId = sub.subscription_id
    params.MonitoredItemIds = [server_handle]
    params.MonitoringMode = monitoring_mode
    results = await sub.server.set_monitoring_mode(params)
    result = results[0]
    if result.is_good():
        for item in sub._monitored_items.values():
            if item.server_handle == server_handle:
                item.monitoring_mode = monitoring_mode
                break
    return result


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


def _convert_scalar(raw: str, sample: Any) -> Any:
    py_type = type(sample)
    if py_type is bool:
        return str(raw).strip().lower() in ("true", "1", "yes", "on")
    try:
        return py_type(raw)
    except (ValueError, TypeError):
        return raw


def _coerce_value_for_write(raw: str, current_val: Any) -> Any:
    """Convert a user-supplied string into a value matching the current node value's type.

    Handles both scalars and 1-D arrays (rendered as e.g. "[0, 1, 2]").
    """
    text = str(raw).strip()
    if isinstance(current_val, (list, tuple)):
        inner = text
        if inner.startswith("[") and inner.endswith("]"):
            inner = inner[1:-1]
        parts = [p.strip() for p in inner.split(",")] if inner.strip() else []
        sample = current_val[0] if current_val else ""
        return [_convert_scalar(p, sample) for p in parts]
    return _convert_scalar(text, current_val)


def _apply_edited_value(current: Any, edited: Any) -> Any:
    """Rebuild a value matching `current`'s live Python/asyncua types, applying
    user-edited scalar leaves from an edited value-tree shaped like the JSON
    produced by `_serialize_value`/`_serialize_element` (i.e. the "Array Viewer"
    structure sent back from the frontend).

    Struct branches are deep-copied from `current` and only the fields present
    in `edited["fields"]` are overwritten (via setattr); fields with no real
    attribute counterpart (e.g. NodeId's synthetic keys) are silently skipped,
    so non-editable structs simply round-trip unchanged.
    """
    if isinstance(edited, dict):
        etype = edited.get("_type")
        if etype == "scalar":
            return _convert_scalar(str(edited.get("value", "")), current)
        if etype == "struct":
            fields = edited.get("fields") or {}
            obj = copy.deepcopy(current)
            for key, sub_edited in fields.items():
                if not hasattr(obj, key):
                    continue
                try:
                    sub_current = getattr(obj, key)
                    setattr(obj, key, _apply_edited_value(sub_current, sub_edited))
                except Exception:
                    continue
            return obj
        return current
    if isinstance(edited, list):
        if isinstance(current, (list, tuple)):
            result = []
            for i, sub_edited in enumerate(edited):
                sub_current = current[i] if i < len(current) else (current[0] if current else None)
                result.append(_apply_edited_value(sub_current, sub_edited))
            return result
        return current
    return current


_COMMON_ATTRS = [
    (ua.AttributeIds.NodeId, "NodeId"),
    (ua.AttributeIds.NodeClass, "NodeClass"),
    (ua.AttributeIds.BrowseName, "BrowseName"),
    (ua.AttributeIds.DisplayName, "DisplayName"),
    (ua.AttributeIds.Description, "Description"),
    (ua.AttributeIds.WriteMask, "WriteMask"),
    (ua.AttributeIds.UserWriteMask, "UserWriteMask"),
]

_VARIABLE_ATTRS = [
    (ua.AttributeIds.Value, "Value"),
    (ua.AttributeIds.DataType, "DataType"),
    (ua.AttributeIds.ValueRank, "ValueRank"),
    (ua.AttributeIds.ArrayDimensions, "ArrayDimensions"),
    (ua.AttributeIds.AccessLevel, "AccessLevel"),
    (ua.AttributeIds.UserAccessLevel, "UserAccessLevel"),
    (ua.AttributeIds.MinimumSamplingInterval, "MinimumSamplingInterval"),
    (ua.AttributeIds.Historizing, "Historizing"),
]

_OBJECT_ATTRS = [(ua.AttributeIds.EventNotifier, "EventNotifier")]

_METHOD_ATTRS = [
    (ua.AttributeIds.Executable, "Executable"),
    (ua.AttributeIds.UserExecutable, "UserExecutable"),
]


async def _format_attribute_value(name: str, val: Any) -> str:
    if val is None:
        return ""
    if name == "NodeId":
        try:
            return val.to_string()
        except Exception:
            return str(val)
    if name == "NodeClass":
        try:
            return ua.NodeClass(val).name
        except Exception:
            return str(val)
    if name == "BrowseName":
        try:
            return f"{val.NamespaceIndex}:{val.Name}"
        except Exception:
            return str(val)
    if name in ("DisplayName", "Description"):
        try:
            return val.Text or ""
        except Exception:
            return str(val)
    if name == "DataType":
        try:
            dt_node = state.client.get_node(val)
            bn = await dt_node.read_browse_name()
            if bn and getattr(bn, "Name", None):
                return bn.Name
        except Exception:
            pass
        try:
            return val.to_string()
        except Exception:
            return str(val)
    return _safe_value_repr(val)


def _is_complex_value(val: Any) -> bool:
    """True if val is (or contains) a struct/ExtensionObject/NodeId/etc, rather than
    plain scalars, so the frontend can decide between inline text editing vs a
    read-only structured viewer."""
    if val is None or isinstance(val, (bool, int, float, str, bytes, bytearray)):
        return False
    if isinstance(val, (list, tuple)):
        return any(_is_complex_value(v) for v in val)
    return True


async def _read_node_attributes(node_id: str) -> dict:
    node = await _get_node(node_id)
    display_name = ""
    try:
        display_name = (await node.read_display_name()).Text
    except Exception:
        pass

    node_class: Optional[ua.NodeClass] = None
    try:
        node_class = await node.read_node_class()
    except Exception:
        pass

    attrs_to_read = list(_COMMON_ATTRS)
    if node_class == ua.NodeClass.Variable:
        attrs_to_read += _VARIABLE_ATTRS
    elif node_class == ua.NodeClass.Object:
        attrs_to_read += _OBJECT_ATTRS
    elif node_class == ua.NodeClass.Method:
        attrs_to_read += _METHOD_ATTRS

    attributes = []
    writable = False
    value_is_complex = False
    value_raw = None
    for attr_id, name in attrs_to_read:
        try:
            dv = await node.read_attribute(attr_id)
            val = dv.Value.Value
            display_val = await _format_attribute_value(name, val)
            attributes.append({"name": name, "value": display_val})
            if name == "Value":
                writable = True
                # Arrays (even of plain scalars) and struct-like values are all
                # routed to the structured "Array Viewer" instead of the inline
                # text input, since a single-line box is impractical for either.
                value_is_complex = isinstance(val, (list, tuple)) or _is_complex_value(val)
                if value_is_complex:
                    value_raw = _serialize_value(val)
        except Exception as e:
            err = _status_code_from_error_text(str(e)) or "N/A"
            attributes.append({"name": name, "value": "", "error": err})

    return {
        "node_id": node_id,
        "display_name": display_name,
        "node_class": node_class.name if node_class is not None else "",
        "attributes": attributes,
        "writable": writable,
        "value_is_complex": value_is_complex,
        "value_raw": value_raw,
    }


__all__ = [
    "Client",
    "Node",
    "SharedSubHandler",
    "_apply_edited_value",
    "_broadcast",
    "_browse_children",
    "_coerce_value_for_write",
    "_fmt_ts",
    "_get_node",
    "_is_complex_value",
    "_read_node_attributes",
    "_res",
    "_resolve_data_type_name",
    "_safe_value_repr",
    "_serialize_value",
    "_status_code_from_error_text",
    "_shared_handler",
    "reset_connection_state",
]
