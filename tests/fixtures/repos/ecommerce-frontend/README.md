# @ecommerce/frontend

React + Vite + TypeScript storefront. Calls the Python `ecommerce-backend`
over HTTP and renders products via `@ecommerce/shared`.

## Wire surface

- `useProducts()` → `GET /products` → `ProductListResponse` (from `@ecommerce/shared`)
- Errors flow as `ApiError` (from `@ecommerce/shared/errors`) — backend's `{code, message, status}` JSON envelope is parsed in `lib/api.ts`.
