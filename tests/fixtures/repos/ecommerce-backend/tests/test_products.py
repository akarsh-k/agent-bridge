from fastapi.testclient import TestClient

from app.main import create_app


def test_list_products_returns_seed():
    client = TestClient(create_app())
    res = client.get("/products")
    assert res.status_code == 200
    body = res.json()
    assert body["total"] == 3
    ids = {p["id"] for p in body["products"]}
    assert ids == {"prod_keyboard", "prod_mouse", "prod_monitor"}


def test_get_product_404_envelope():
    client = TestClient(create_app())
    res = client.get("/products/does_not_exist")
    assert res.status_code == 404
    body = res.json()
    assert body["code"] == "product_not_found"
    assert "does_not_exist" in body["message"]
