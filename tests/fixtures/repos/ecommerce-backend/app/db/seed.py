"""In-memory product catalogue. Real backend would hit Postgres; we keep
it as a list so the demo stays self-contained."""

from app.models.product import Product


_SEED: list[Product] = [
    Product(
        id="prod_keyboard",
        name="Mechanical Keyboard",
        description="Tactile switches, hot-swappable, RGB.",
        priceCents=12_900,
        currency="USD",
        inStock=True,
    ),
    Product(
        id="prod_mouse",
        name="Wireless Mouse",
        description="Ergonomic, 90-hour battery, 800-1600 DPI.",
        priceCents=4_900,
        currency="USD",
        inStock=True,
    ),
    Product(
        id="prod_monitor",
        name="27\" 4K Monitor",
        description="IPS panel, 144Hz, USB-C power delivery.",
        priceCents=49_900,
        currency="USD",
        inStock=False,
    ),
]


def all_products() -> list[Product]:
    return list(_SEED)


def find_product(product_id: str) -> Product | None:
    return next((p for p in _SEED if p.id == product_id), None)
