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
    # User-configurable OPC UA subscription parameters, applied to the shared
    # subscription used for all monitored items. Persists across
    # connect/disconnect cycles within the process lifetime.
    subscription_settings: dict[str, Any] = field(
        default_factory=lambda: {
            "name": "Subscription 1",
            "publishing_interval": 500.0,
            "keep_alive_count": 10,
            "lifetime_count": 1000,
            "max_notifications_per_publish": 0,
            "priority": 0,
            "timestamps_to_return": "Both",
            "publishing_enabled": True,
        }
    )


state = AppState()
