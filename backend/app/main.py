"""PLUME API — FastAPI application factory."""

from __future__ import annotations

import logging
import time
import uuid

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse

from app.api import routes_data, routes_repair
from app.config import get_settings
from app.logging_setup import configure_logging

log = logging.getLogger("plume.api")


def create_app() -> FastAPI:
    configure_logging()
    settings = get_settings()
    app = FastAPI(
        title="PLUME API",
        version="0.1.0",
        description=(
            "Methane incident investigation, Proof-of-Repair escrow coordination and verification. "
            "Observations are real historical Carbon Mapper data; repair projects are simulations on a test network."
        ),
    )
    app.add_middleware(GZipMiddleware, minimum_size=1024)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.middleware("http")
    async def request_log(request: Request, call_next):  # type: ignore[no-untyped-def]
        rid = request.headers.get("x-request-id") or uuid.uuid4().hex[:12]
        t0 = time.perf_counter()
        try:
            response = await call_next(request)
        except Exception:
            log.exception("unhandled error", extra={"request_id": rid, "path": request.url.path})
            return JSONResponse({"detail": "internal server error", "request_id": rid}, status_code=500)
        ms = round((time.perf_counter() - t0) * 1000, 1)
        response.headers["x-request-id"] = rid
        response.headers["server-timing"] = f"app;dur={ms}"
        log.info(
            "request",
            extra={
                "request_id": rid,
                "method": request.method,
                "path": request.url.path,
                "status": response.status_code,
                "ms": ms,
            },
        )
        return response

    app.include_router(routes_data.router)
    app.include_router(routes_repair.router)
    return app


app = create_app()
