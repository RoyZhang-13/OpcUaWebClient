# OPC UA Web Client

An OPC UA Web Client based on Python (asyncua + FastAPI).

## Project Structure

```
OpcUaWebClient/
├── .venv/              # Python virtual environment (local)
├── app/                # Backend modules
│   ├── opcua.py         # OPC UA client logic
│   ├── routes.py        # FastAPI routes
│   ├── server.py         # FastAPI app and static file mounting
│   └── state.py         # Shared application state
├── frontend/
│   ├── index.html
│   ├── js/              # Frontend logic (ES Modules)
│   │   ├── main.js        # Entry point, DOM event bindings
│   │   ├── state.js       # Shared state, logs, connection status
│   │   ├── api.js         # REST request wrapper
│   │   ├── ws.js          # WebSocket real-time push
│   │   ├── tree.js        # Address space tree browsing
│   │   ├── monitor.js     # Monitor table
│   │   ├── dialogs.js     # Add/settings dialogs
│   │   ├── contextmenu.js # Context menu
│   │   └── utils.js       # Pure utility functions
│   └── styles/           # Frontend styles (split by feature)
│       ├── main.css       # Entry point, @import summary
│       ├── base.css
│       ├── layout.css
│       ├── tree.css
│       ├── monitor-table.css
│       ├── context-menu.css
│       └── dialogs.css
├── main.py             # Backend entry point
└── requirements.txt
```

## Getting Started

```bash
# Activate virtual environment (Windows)
.venv\Scripts\activate

# Start backend (hot reload)
python main.py
```

Open http://127.0.0.1:9003 in your browser.

## Docker

```bash
# Build image
docker build -t opcua-web-client .

# Run container
docker run --rm -p 9003:9003 --name opcua-web-client opcua-web-client

# Stop container
docker stop opcua-web-client
```

Open http://127.0.0.1:9003 in your browser.

## Features

- Connect / disconnect OPC UA Server (supports username/password)
- Address space browsing (tree expansion)
- Read node values
- Write node values (automatic type matching)
- Subscribe to node changes (real-time push via WebSocket)
- IndexRange subscription (right-click menu → Item Settings, supports `n`, `n:m`, `n:m,n:m` formats)

## Packaging as a Single EXE

The packaged exe can run directly on Windows x64 machines without a Python environment.

```bash
# Activate virtual environment (install PyInstaller the first time)
.venv\Scripts\activate
pip install pyinstaller

# Package (generates dist\OpcUaWebClient.exe)
pyinstaller OpcUaWebClient.spec --clean

# Repackage (after code changes)
pyinstaller OpcUaWebClient.spec --clean
```

The packaged artifact is located at `dist\OpcUaWebClient.exe` (about 24 MB). Double-click to run, then open http://127.0.0.1:9003 in your browser.

> **Tip:** The first launch is slightly slower (PyInstaller extracts to a temporary directory), and Windows Defender may trigger a scan — this is normal.
