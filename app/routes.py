from __future__ import annotations

from contextlib import asynccontextmanager
from typing import Optional

from asyncua import Client, ua
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from app.opcua import (
    _browse_children,
    _fmt_ts,
    _get_node,
    _res,
    _resolve_data_type_name,
    _safe_value_repr,
    _serialize_value,
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


class SubscribeRequest(BaseModel):
    seq: int
    node_id: str
    index_range: Optional[str] = None


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
                "value_raw": _serialize_value(value) if isinstance(value, (list, tuple)) else None,
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
            current_dv = await node.read_data_value()
            current_val = current_dv.Value.Value
            if req.data_type == "auto" and current_val is not None:
                target_type = type(current_val)
                try:
                    new_val = target_type(req.value)
                except (ValueError, TypeError):
                    new_val = req.value
            else:
                new_val = req.value
            await node.write_value(new_val)
            return {"status": "ok", "node_id": req.node_id, "written_value": str(new_val)}
        except Exception as e:
            return {"error": str(e)}

    @app.post("/api/subscribe")
    async def subscribe(req: SubscribeRequest):
        if not state.connected:
            return {"error": "Not connected"}
        seq = req.seq
        if seq in state.subscriptions:
            return {"status": "already_subscribed", "seq": seq}
        node_id = req.node_id
        try:
            node = await _get_node(node_id)
            display_name = ""
            try:
                display_name = (await node.read_display_name()).Text
            except Exception:
                pass
            if state.shared_sub is None:
                state.shared_sub = await state.client.create_subscription(500, _shared_handler)
            mir = state.shared_sub._make_monitored_item_request(
                node, ua.AttributeIds.Value, None, 0, ua.MonitoringMode.Reporting, 500.0
            )
            client_handle = mir.RequestedParameters.ClientHandle
            if req.index_range:
                mir.ItemToMonitor.IndexRange = req.index_range
            results = await state.shared_sub.create_monitored_items([mir])
            handle = results[0]
            if isinstance(handle, ua.StatusCode):
                return {"error": f"Subscribe failed: {handle}"}
            state.subscriptions[seq] = {
                "handle": handle,
                "client_handle": client_handle,
                "node_id": node_id,
                "display_name": display_name,
                "index_range": req.index_range,
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
            return {"status": "unsubscribed", "seq": seq}
        except Exception as e:
            return {"error": str(e)}

    @app.get("/api/subscriptions")
    async def list_subscriptions():
        return {"subscriptions": list(state.subscriptions.keys())}

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
