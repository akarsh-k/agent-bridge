"""Wire-level error envelope — mirrors `ecommerce-shared/src/errors.ts:ApiError`.

The frontend's `api.ts` parses `{code, message}` JSON bodies on non-2xx
responses into an `ApiError` instance. The exception handler below makes
sure FastAPI's default 500 page never reaches the wire — every error
becomes the same envelope shape regardless of origin.
"""

from typing import Any

from fastapi import Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel


class ApiErrorPayload(BaseModel):
    code: str
    message: str


class ApiError(Exception):
    def __init__(self, code: str, message: str, status: int = 500):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status


async def api_error_handler(_: Request, exc: ApiError) -> JSONResponse:
    return JSONResponse(
        status_code=exc.status,
        content=ApiErrorPayload(code=exc.code, message=exc.message).model_dump(),
    )


async def fallback_error_handler(_: Request, exc: Exception) -> JSONResponse:
    return JSONResponse(
        status_code=500,
        content=ApiErrorPayload(
            code="internal_error",
            message=str(exc) or "Internal server error",
        ).model_dump(),
    )


def install_error_handlers(app: Any) -> None:
    app.add_exception_handler(ApiError, api_error_handler)
    app.add_exception_handler(Exception, fallback_error_handler)
