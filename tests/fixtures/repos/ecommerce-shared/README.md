# @ecommerce/shared

Shared TypeScript types + utilities for the ecommerce demo.

Consumed directly by `ecommerce-frontend`. The Python `ecommerce-backend`
does NOT import this package; it maintains a parallel definition of
`Product` (Pydantic) and the `repo_relationships` row in the agent's config
records the cross-language correspondence.

## Exports

- `Product`, `ProductListResponse`, `isProduct` — `./product`
- `formatPrice`, `totalCents`, `applyDiscount` — `./pricing`
- `ApiError`, `isApiError` — `./errors`
