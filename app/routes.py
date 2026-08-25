from __future__ import annotations

from contextlib import asynccontextmanager
from typing import Any, Optional

from asyncua import Client, ua
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from app.opcua import (
    _apply_edited_value,
    _browse_children,
    _coerce_value_for_write,
    _create_monitored_item_with_timestamps,
    _fmt_ts,
    _get_node,
    _is_complex_value,
    _modify_monitored_item_full,
    _read_node_attributes,
    _res,
    _resolve_data_type_name,
    _safe_value_repr,
    _serialize_value,
    _set_monitoring_mode_for_item,
    _shared_handler,
    _status_code_from_error_text,
    reset_connection_state,
)
from app.state import state


class ConnectRequest(BaseModel):
    url: str
    username: Optional[str] = None
    password: Optional[str] = None


class WriteRequest(BaseModel):
    node_id: str
    value: str
    data_type: str = "auto"
    index_range: Optional[str] = None


class WriteStructuredRequest(BaseModel):
    node_id: str
    value: Any
    index_range: Optional[str] = None


class SubscribeRequest(BaseModel):
    seq: int
    node_id: str
    index_range: Optional[str] = None
    sampling_interval: Optional[float] = None
    queue_size: Optional[int] = None
    discard_oldest: Optional[bool] = None
    monitoring_mode: Optional[str] = None


class SubscriptionSettingsRequest(BaseModel):
    name: Optional[str] = None
    publishing_interval: Optional[float] = None
    keep_alive_count: Optional[int] = None
    lifetime_count: Optional[int] = None
    max_notifications_per_publish: Optional[int] = None
    priority: Optional[int] = None
    timestamps_to_return: Optional[str] = None
    publishing_enabled: Optional[bool] = None


class MonitoredItemSettingsRequest(BaseModel):
    seq: int
    sampling_interval: Optional[float] = None
    queue_size: Optional[int] = None
    discard_oldest: Optional[bool] = None
    monitoring_mode: Optional[str] = None


@asynccontextmanager
async def lifespan(_: FastAPI):
    yield
    if state.client:
        await state.client.disconnect()


def create_app() -> FastAPI:
    app = FastAPI(title="OPC UA Web Client", lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.middleware("http")
    async def no_cache_static(request: Request, call_next):
        response = await call_next(request)
        if request.url.path.startswith("/static/") or request.url.path == "/":
            response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate"
            response.headers["Pragma"] = "no-cache"
        return response

    app.mount("/static", StaticFiles(directory=_res("frontend")), name="static")

    @app.get("/")
    async def index():
        return FileResponse(_res("frontend/index.html"))

    @app.post("/api/connect")
    async def connect(req: ConnectRequest):
        if state.connected:
            await reset_connection_state()

        client = Client(req.url, timeout=30)
        if req.username:
            client.set_user(req.username)
        if req.password:
            client.set_password(req.password)

        try:
            await client.connect()
            try:
                await client.load_data_type_definitions()
            except Exception:
                pass
            state.client = client
            state.connected = True
            state.server_url = req.url
            return {"status": "connected", "url": req.url}
        except Exception as e:
            return {"status": "error", "message": str(e)}

    @app.post("/api/disconnect")
    async def disconnect():
        if state.client and state.connected:
            try:
                await state.client.disconnect()
            except Exception:
                pass
        await reset_connection_state()
        return {"status": "disconnected"}

    @app.get("/api/status")
    async def status():
        return {"connected": state.connected, "url": state.server_url}

    @app.get("/api/browse")
    async def browse(node_id: str = "i=84"):
        if not state.connected:
            return {"error": "Not connected"}
        try:
            node = await _get_node(node_id)
            children = await _browse_children(node)
            display_name = (await node.read_display_name()).Text
            return {"node_id": node_id, "display_name": display_name, "children": children}
        except Exception as e:
            return {"error": str(e)}

    @app.get("/api/node_attributes")
    async def node_attributes(node_id: str, index_range: Optional[str] = None):
        if not state.connected:
            return {"error": "Not connected"}
        try:
            return await _read_node_attributes(node_id, index_range)
        except Exception as e:
            return {"error": str(e)}

    @app.get("/api/read")
    async def read_node(node_id: str):
        if not state.connected:
            return {"error": "Not connected"}
        try:
            node = await _get_node(node_id)
            display_name = ""
            try:
                display_name = (await node.read_display_name()).Text
            except Exception:
                pass
            try:
                dv = await node.read_data_value()
            except Exception as e:
                return {
                    "node_id": node_id,
                    "display_name": display_name,
                    "value": "",
                    "value_raw": None,
                    "data_type": "",
                    "source_timestamp": "",
                    "server_timestamp": "",
                    "status_code": _status_code_from_error_text(str(e)),
                    "error": str(e),
                }
            value = dv.Value.Value
            data_type = ""
            try:
                data_type = await _resolve_data_type_name(node, value)
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
            try:
                sc = dv.StatusCode
                status_code = f"{sc.name} (0x{sc.value:08X})"
            except Exception:
                status_code = "Good"
            source_ts = _fmt_ts(dv.SourceTimestamp)
            server_ts = _fmt_ts(dv.ServerTimestamp) or source_ts
            return {
                "node_id": node_id,
                "display_name": display_name,
                "value": _safe_value_repr(value),
                "value_raw": _serialize_value(value) if isinstance(value, (list, tuple)) or _is_complex_value(value) else None,
                "data_type": data_type,
                "source_timestamp": source_ts,
                "server_timestamp": server_ts,
                "status_code": status_code,
            }
        except Exception as e:
            return {"error": str(e)}

    @app.post("/api/write")
    async def write_node(req: WriteRequest):
        if not state.connected:
            return {"error": "Not connected"}
        try:
            node = await _get_node(req.node_id)
            current_dv = await node.read_attribute(ua.AttributeIds.Value, req.index_range)
            current_val = current_dv.Value.Value
            if req.data_type == "auto" and current_val is not None:
                new_val = _coerce_value_for_write(req.value, current_val)
            else:
                new_val = req.value
            variant_type = None
            try:
                variant_type = current_dv.Value.VariantType
            except Exception:
                pass
            # Build a DataValue with only Value set (no timestamps/status). Some
            # servers reply BadWriteNotSupported if timestamps are included, which
            # asyncua's write_value() does by default (SourceTimestamp=now()).
            await node.write_attribute(
                ua.AttributeIds.Value, ua.DataValue(ua.Variant(new_val, variant_type)), req.index_range
            )
            return {"status": "ok", "node_id": req.node_id, "written_value": str(new_val)}
        except Exception as e:
            return {"error": str(e)}

    @app.post("/api/write_structured")
    async def write_structured_node(req: WriteStructuredRequest):
        """Write a struct / array-of-structs value edited via the Array Viewer.

        `req.value` mirrors the JSON tree produced by `_serialize_value` (as
        returned in `value_raw`), with user-edited scalar leaves. The current
        live value is read first and only edited leaves are applied on top of
        it (via `_apply_edited_value`), so untouched/non-editable fields (e.g.
        NodeId's synthetic keys) simply round-trip unchanged.
        """
        if not state.connected:
            return {"error": "Not connected"}
        try:
            node = await _get_node(req.node_id)
            current_dv = await node.read_attribute(ua.AttributeIds.Value, req.index_range)
            current_val = current_dv.Value.Value
            new_val = _apply_edited_value(current_val, req.value)
            variant_type = None
            try:
                variant_type = current_dv.Value.VariantType
            except Exception:
                pass
            await node.write_attribute(
                ua.AttributeIds.Value, ua.DataValue(ua.Variant(new_val, variant_type)), req.index_range
            )
            return {"status": "ok", "node_id": req.node_id, "written_value": _safe_value_repr(new_val)}
        except Exception as e:
            return {"error": str(e)}

    async def _unsubscribe_seq(seq: int) -> bool:
        """Tear down the monitored item stored under `seq`, if any."""
        if seq not in state.subscriptions:
            return False
        entry = state.subscriptions.pop(seq)
        client_handle = entry.get("client_handle")
        handle = entry["handle"]
        if client_handle is not None:
            state.client_handle_to_seq.pop(client_handle, None)
        if state.shared_sub is not None:
            await state.shared_sub.unsubscribe(handle)
        if not state.subscriptions and state.shared_sub is not None:
            try:
                await state.shared_sub.delete()
            except Exception:
                pass
            state.shared_sub = None
        return True

    @app.post("/api/subscribe")
    async def subscribe(req: SubscribeRequest):
        if not state.connected:
            return {"error": "Not connected"}
        seq = req.seq
        node_id = req.node_id
        if seq in state.subscriptions:
            existing = state.subscriptions[seq]
            if existing.get("node_id") == node_id and existing.get("index_range") == req.index_range:
                return {"status": "already_subscribed", "seq": seq}
            # Stale leftover entry under this seq (e.g. a page refresh reset the
            # client-side sequence counter while the server-side subscription
            # from before the refresh is still alive). Tear it down before
            # creating the monitored item the caller actually asked for, so
            # the seq doesn't end up silently pointing at the wrong node.
            try:
                await _unsubscribe_seq(seq)
            except Exception:
                pass
        try:
            node = await _get_node(node_id)
            display_name = ""
            try:
                display_name = (await node.read_display_name()).Text
            except Exception:
                pass
            if state.shared_sub is None:
                s = state.subscription_settings
                sub_params = ua.CreateSubscriptionParameters()
                sub_params.RequestedPublishingInterval = s["publishing_interval"]
                sub_params.RequestedLifetimeCount = s["lifetime_count"]
                sub_params.RequestedMaxKeepAliveCount = s["keep_alive_count"]
                sub_params.MaxNotificationsPerPublish = s["max_notifications_per_publish"]
                sub_params.PublishingEnabled = s["publishing_enabled"]
                sub_params.Priority = s["priority"]
                state.shared_sub = await state.client.create_subscription(sub_params, _shared_handler)
            sampling_interval = (
                req.sampling_interval if req.sampling_interval is not None else state.subscription_settings["publishing_interval"]
            )
            queue_size = req.queue_size if req.queue_size is not None else 1
            discard_oldest = req.discard_oldest if req.discard_oldest is not None else True
            monitoring_mode_name = req.monitoring_mode if req.monitoring_mode is not None else "Reporting"
            monitoring_mode = ua.MonitoringMode[monitoring_mode_name]
            mir = state.shared_sub._make_monitored_item_request(
                node, ua.AttributeIds.Value, None, queue_size, monitoring_mode, sampling_interval
            )
            mir.RequestedParameters.DiscardOldest = discard_oldest
            client_handle = mir.RequestedParameters.ClientHandle
            if req.index_range:
                mir.ItemToMonitor.IndexRange = req.index_range
            handle = await _create_monitored_item_with_timestamps(
                state.shared_sub, mir, state.subscription_settings["timestamps_to_return"]
            )
            if isinstance(handle, ua.StatusCode):
                return {"error": f"Subscribe failed: {handle}"}
            state.subscriptions[seq] = {
                "handle": handle,
                "client_handle": client_handle,
                "node_id": node_id,
                "display_name": display_name,
                "index_range": req.index_range,
                "sampling_interval": sampling_interval,
                "queue_size": queue_size,
                "discard_oldest": discard_oldest,
                "monitoring_mode": monitoring_mode_name,
            }
            state.client_handle_to_seq[client_handle] = seq
            return {"status": "subscribed", "seq": seq, "node_id": node_id}
        except Exception as e:
            return {"error": str(e)}

    @app.delete("/api/subscribe")
    async def unsubscribe(seq: int):
        if seq not in state.subscriptions:
            return {"status": "not_subscribed"}
        try:
            await _unsubscribe_seq(seq)
            return {"status": "unsubscribed", "seq": seq}
        except Exception as e:
            return {"error": str(e)}

    @app.get("/api/subscriptions")
    async def list_subscriptions():
        return {"subscriptions": list(state.subscriptions.keys())}

    @app.get("/api/subscription_settings")
    async def get_subscription_settings():
        result = dict(state.subscription_settings)
        result["subscription_id"] = state.shared_sub.subscription_id if state.shared_sub is not None else None
        result["active"] = state.shared_sub is not None
        return result

    @app.post("/api/subscription_settings")
    async def update_subscription_settings(req: SubscriptionSettingsRequest):
        s = state.subscription_settings
        if req.name is not None:
            s["name"] = req.name
        if req.publishing_interval is not None:
            s["publishing_interval"] = req.publishing_interval
        if req.keep_alive_count is not None:
            s["keep_alive_count"] = req.keep_alive_count
        if req.lifetime_count is not None:
            s["lifetime_count"] = req.lifetime_count
        if req.max_notifications_per_publish is not None:
            s["max_notifications_per_publish"] = req.max_notifications_per_publish
        if req.priority is not None:
            s["priority"] = req.priority
        if req.timestamps_to_return is not None:
            s["timestamps_to_return"] = req.timestamps_to_return
        if req.publishing_enabled is not None:
            s["publishing_enabled"] = req.publishing_enabled

        if state.shared_sub is not None:
            try:
                mparams = ua.ModifySubscriptionParameters()
                mparams.SubscriptionId = state.shared_sub.subscription_id
                mparams.RequestedPublishingInterval = s["publishing_interval"]
                mparams.RequestedLifetimeCount = s["lifetime_count"]
                mparams.RequestedMaxKeepAliveCount = s["keep_alive_count"]
                mparams.MaxNotificationsPerPublish = s["max_notifications_per_publish"]
                mparams.Priority = s["priority"]
                revised = await state.shared_sub.update(mparams)
                s["publishing_interval"] = revised.RevisedPublishingInterval
                s["lifetime_count"] = revised.RevisedLifetimeCount
                s["keep_alive_count"] = revised.RevisedMaxKeepAliveCount
                if req.publishing_enabled is not None:
                    pub_params = ua.SetPublishingModeParameters()
                    pub_params.PublishingEnabled = s["publishing_enabled"]
                    pub_params.SubscriptionIds = [state.shared_sub.subscription_id]
                    await state.client.uaclient.set_publishing_mode(pub_params)
            except Exception as e:
                return {"error": str(e)}

        result = dict(s)
        result["subscription_id"] = state.shared_sub.subscription_id if state.shared_sub is not None else None
        result["active"] = state.shared_sub is not None
        return result

    @app.get("/api/monitored_item_settings")
    async def get_monitored_item_settings(seq: int):
        entry = state.subscriptions.get(seq)
        if entry is None:
            return {"error": "Not monitored"}
        return {
            "node_id": entry["node_id"],
            "sampling_interval": entry.get("sampling_interval"),
            "queue_size": entry.get("queue_size"),
            "discard_oldest": entry.get("discard_oldest"),
            "monitoring_mode": entry.get("monitoring_mode"),
        }

    @app.post("/api/monitored_item_settings")
    async def update_monitored_item_settings(req: MonitoredItemSettingsRequest):
        entry = state.subscriptions.get(req.seq)
        if entry is None:
            return {"error": "Not monitored"}
        if state.shared_sub is None:
            return {"error": "No active subscription"}
        try:
            sampling_interval = (
                req.sampling_interval if req.sampling_interval is not None else entry["sampling_interval"]
            )
            queue_size = req.queue_size if req.queue_size is not None else entry["queue_size"]
            discard_oldest = req.discard_oldest if req.discard_oldest is not None else entry["discard_oldest"]
            result = await _modify_monitored_item_full(
                state.shared_sub, entry["handle"], entry["client_handle"], sampling_interval, queue_size, discard_oldest
            )
            if not result.StatusCode.is_good():
                return {"error": f"Modify failed: {result.StatusCode}"}
            entry["sampling_interval"] = result.RevisedSamplingInterval
            entry["queue_size"] = result.RevisedQueueSize
            entry["discard_oldest"] = discard_oldest

            if req.monitoring_mode is not None:
                mode_result = await _set_monitoring_mode_for_item(state.shared_sub, entry["handle"], req.monitoring_mode)
                if not mode_result.is_good():
                    return {"error": f"Set monitoring mode failed: {mode_result}"}
                entry["monitoring_mode"] = req.monitoring_mode

            return {
                "node_id": entry["node_id"],
                "sampling_interval": entry["sampling_interval"],
                "queue_size": entry["queue_size"],
                "discard_oldest": entry["discard_oldest"],
                "monitoring_mode": entry["monitoring_mode"],
            }
        except Exception as e:
            return {"error": str(e)}

    @app.websocket("/ws")
    async def websocket_endpoint(ws: WebSocket):
        await ws.accept()
        state.active_websockets.append(ws)
        try:
            while True:
                await ws.receive_text()
        except WebSocketDisconnect:
            pass
        finally:
            if ws in state.active_websockets:
                state.active_websockets.remove(ws)

    return app


app = create_app()
