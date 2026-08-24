from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional

from asyncua import Client
from fastapi import WebSocket


@dataclass
class AppState:
    client: Optional[Client] = None
    subscriptions: dict[int, Any] = field(default_factory=dict)
    client_handle_to_seq: dict[int, int] = field(default_factory=dict)
    shared_sub: Optional[Any] = None
    active_websockets: list[WebSocket] = field(default_factory=list)
    connected: bool = False
    server_url: str = ""


state = AppState()
