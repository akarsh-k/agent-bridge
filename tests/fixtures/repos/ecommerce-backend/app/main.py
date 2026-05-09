"""FastAPI entry point. Wires routes and error handlers."""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.errors import install_error_handlers
from app.routes import products


def create_app() -> FastAPI:
    app = FastAPI(title="Ecommerce Demo API", version="0.1.0")

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
        allow_methods=["GET"],
        allow_headers=["*"],
    )

    install_error_handlers(app)
    app.include_router(products.router)

    return app


app = create_app()
