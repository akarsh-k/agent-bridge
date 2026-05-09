# ecommerce-backend

FastAPI backend for the ecommerce demo. Cross-language counterpart to
`@ecommerce/shared` — `app.models.product.Product` is the parallel
definition of the TS `Product` interface.

## Routes

- `GET /products` → `ProductListResponse`
- `GET /products/{id}` → `Product` or `404 {code, message}`

## Running locally

```sh
uv pip install -e .[dev]
uvicorn app.main:app --reload --port 8000
pytest
```
