import logging
import sys

import uvicorn

from app.routes import app

logging.basicConfig(level=logging.INFO)

if __name__ == "__main__":
    frozen = getattr(sys, "frozen", False)
    if frozen:
        uvicorn.run(app, host="127.0.0.1", port=9003, reload=False)
    else:
        uvicorn.run("app.server:app", host="127.0.0.1", port=9003, reload=True)
