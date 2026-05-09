from fastapi import APIRouter

from app.db.seed import all_products, find_product
from app.errors import ApiError
from app.models.product import Product, ProductListResponse


router = APIRouter(prefix="/products", tags=["products"])


@router.get("", response_model=ProductListResponse)
def list_products() -> ProductListResponse:
    products = all_products()
    return ProductListResponse(products=products, total=len(products))


@router.get("/{product_id}", response_model=Product)
def get_product(product_id: str) -> Product:
    product = find_product(product_id)
    if product is None:
        raise ApiError(
            code="product_not_found",
            message=f"No product with id={product_id!r}",
            status=404,
        )
    return product
