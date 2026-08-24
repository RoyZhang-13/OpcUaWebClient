# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec for OpcUaWebClient
# Build: pyinstaller OpcUaWebClient.spec

import sys
from PyInstaller.utils.hooks import collect_all, collect_submodules

# ── Collect entire packages that use dynamic imports ───────────────────────
datas_asyncua, binaries_asyncua, hiddenimports_asyncua = collect_all("asyncua")
datas_fastapi,  binaries_fastapi,  hiddenimports_fastapi  = collect_all("fastapi")
datas_uvicorn,  binaries_uvicorn,  hiddenimports_uvicorn  = collect_all("uvicorn")
datas_anyio,    binaries_anyio,    hiddenimports_anyio    = collect_all("anyio")
datas_starlette,binaries_starlette,hiddenimports_starlette= collect_all("starlette")

a = Analysis(
    ["main.py"],
    pathex=[],
    binaries=(
        binaries_asyncua + binaries_fastapi + binaries_uvicorn +
        binaries_anyio + binaries_starlette
    ),
    datas=(
        # Frontend static files
        [("frontend", "frontend")]
        + datas_asyncua + datas_fastapi + datas_uvicorn
        + datas_anyio + datas_starlette
    ),
    hiddenimports=(
        hiddenimports_asyncua + hiddenimports_fastapi +
        hiddenimports_uvicorn + hiddenimports_anyio +
        hiddenimports_starlette +
        [
            # uvicorn entry points
            "uvicorn.logging",
            "uvicorn.loops",
            "uvicorn.loops.auto",
            "uvicorn.loops.asyncio",
            "uvicorn.http",
            "uvicorn.http.auto",
            "uvicorn.http.h11_impl",
            "uvicorn.http.httptools_impl",
            "uvicorn.protocols",
            "uvicorn.protocols.websockets",
            "uvicorn.protocols.websockets.auto",
            "uvicorn.protocols.websockets.websockets_impl",
            "uvicorn.protocols.websockets.wsproto_impl",
            "uvicorn.lifespan",
            "uvicorn.lifespan.on",
            # asyncua crypto / xml
            "asyncua.crypto",
            "asyncua.server",
            "asyncua.client",
            "asyncua.ua",
            "asyncua.ua.uatypes",
            "asyncua.ua.object_ids",
            "asyncua.ua.uaprotocol_auto",
            "asyncua.ua.uaprotocol_hand",
            "asyncua.common",
            "asyncua.common.xmlimporter",
            "asyncua.common.xmlparser",
            "xml.etree.ElementTree",
            # pydantic v2
            "pydantic",
            "pydantic.deprecated",
            "pydantic_core",
            # standard / misc
            "email.mime.text",
            "email.mime.multipart",
            "logging.config",
            "h11",
            "websockets",
            "websockets.legacy",
            "websockets.legacy.server",
            "websockets.legacy.client",
            "websockets.server",
            "websockets.client",
            "cryptography",
            "aiofiles",
        ]
    ),
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="OpcUaWebClient",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,           # UPX can cause false-positive AV; keep off
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,        # keep console window so log output is visible
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon="assets/opcua-client.ico",
    onefile=True,        # single .exe
)

