"""Product model — parallel definition of the TS Product interface in
`ecommerce-shared/src/product.ts`. The agent's `repo_edges` row records
this correspondence; any change to one MUST be mirrored in the other.

Field-name choice notes:
- `priceCents` (camelCase) keeps the wire-shape identical to the TS
  client without the frontend having to remap. FastAPI's response
  serializer respects pydantic field names verbatim.
- `currency` is a `Literal` so the Python and TS unions stay aligned.
"""

from typing import Literal

from pydantic import BaseModel, Field


Currency = Literal["USD", "EUR", "GBP"]


class Product(BaseModel):
    id: str
    name: str
    description: str
    priceCents: int = Field(ge=0, description="Price in the smallest currency unit (cents)")
    currency: Currency = "USD"
    inStock: bool = True


class ProductListResponse(BaseModel):
    products: list[Product]
    total: int
