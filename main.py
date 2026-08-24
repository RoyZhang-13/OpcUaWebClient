"""Compatibility wrapper for the packaged app.

The actual application logic lives in the app/ package, while this file keeps the
original entry point for `python main.py` and PyInstaller flows.
"""

import sys

import uvicorn

from app.server import app


if __name__ == "__main__":
    frozen = getattr(sys, "frozen", False)
    if frozen:
        uvicorn.run(app, host="127.0.0.1", port=9003, reload=False)
    else:
        uvicorn.run("app.server:app", host="127.0.0.1", port=9003, reload=True)
