"""Uc katmanli cikarim: JSON-LD -> OpenGraph -> son care."""

from __future__ import annotations

from pathlib import Path

import pytest

from collect.link.extract import extract

FIXTURES = Path(__file__).parent / "fixtures" / "link"


def _read(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


def test_json_ld_is_preferred() -> None:
    product = extract(_read("product_jsonld.html"))
    assert product is not None
    assert product.source_layer == "json_ld"
    assert product.title == "Deri Omuz Cantasi Siyah"
    assert product.price_text == "1899.90"
    assert product.currency == "TRY"
    assert product.brand == "Kuzey Deri"
    assert product.gtin == "8680000000123"
    assert product.in_stock is True
    assert product.low_confidence is False


def test_json_ld_inside_graph_with_offer_array() -> None:
    """Gercek sitelerin yaygin hali: @graph icinde, offers bir dizi."""
    product = extract(_read("product_jsonld_graph.html"))
    assert product is not None
    assert product.source_layer == "json_ld"
    assert product.title == "Suet Spor Ayakkabi Bej"
    # Sayisal fiyat da metne cevrilmeli.
    assert product.price_text == "2450"
    assert product.brand == "Vira"
    assert product.in_stock is False


def test_falls_back_to_opengraph() -> None:
    product = extract(_read("product_opengraph.html"))
    assert product is not None
    assert product.source_layer == "opengraph"
    assert product.title == "Poplin Gomlek Beyaz"
    assert product.price_text == "749.00"
    assert product.brand == "Ela Studio"
    assert product.in_stock is True
    assert product.low_confidence is False


def test_last_resort_is_marked_low_confidence() -> None:
    """Yapilandirilmis veri yoksa sezgisel katman calisir ama guvenilmez sayilir."""
    product = extract(_read("product_bare.html"))
    assert product is not None
    assert product.source_layer == "heuristic"
    assert product.low_confidence is True
    assert "Triko Kazak Bordo" in (product.title or "")
    assert product.price_text is not None


def test_non_product_page_yields_nothing() -> None:
    assert extract(_read("not_a_product.html")) is None


@pytest.mark.parametrize(
    ("html", "expected_layer"),
    [
        (
            "<html><head><script type='application/ld+json'>{bozuk</script>"
            "<meta property='og:title' content='X'>"
            "<meta property='product:price:amount' content='10.00'></head></html>",
            "opengraph",
        ),
    ],
)
def test_broken_json_ld_does_not_break_the_page(html: str, expected_layer: str) -> None:
    """Bozuk bir JSON-LD blogu sayfayi bitirmez; sonraki katmana gecilir."""
    product = extract(html)
    assert product is not None
    assert product.source_layer == expected_layer


# --- link aramasi (docs/decisions/0035) -------------------------------------


def test_shopify_image_object_gives_url_not_name() -> None:
    product = extract(_read("product_shopify.html"))
    assert product is not None
    assert product.source_layer == "json_ld"
    assert product.image_url == "https://cdn.shopify.example/s/files/1/0001/canta-1.jpg?v=1"
    assert product.sku == "ODB-SRT-001-BLK"
    assert product.price_text == "2499.0"


def test_price_less_product_is_rejected_for_the_catalog() -> None:
    # Varsayilan (katalog / yenileme) davranisi degismedi: fiyat yoksa ve
    # yalnizca gorunen metinde bir sayi varsa sezgisel katman devreye girer.
    product = extract(_read("product_reference_no_price.html"))
    assert product is None or product.source_layer == "heuristic"


def test_price_less_product_is_a_reference_for_link_search() -> None:
    product = extract(_read("product_reference_no_price.html"), allow_reference=True)
    assert product is not None
    assert product.source_layer == "json_ld"
    assert product.title == "Ahsap Yemek Sandalyesi Ceviz"
    assert product.price_text is None  # govdedeki "1299 TL" fiyat sayilmadi
    assert product.image_url == "/media/sandalye-ceviz.jpg"


def test_og_product_without_price_is_a_reference() -> None:
    html = (
        '<html><head><meta property="og:type" content="product">'
        '<meta property="og:title" content="Keten Gomlek">'
        '<meta property="og:image" content="https://cdn.example/g.jpg"></head></html>'
    )
    product = extract(html, allow_reference=True)
    assert product is not None
    assert product.title == "Keten Gomlek"
    assert product.price_text is None


def test_plain_page_is_not_a_reference_even_in_link_search() -> None:
    html = (
        "<html><head><title>Hakkimizda</title>"
        '<meta property="og:title" content="Hakkimizda"></head></html>'
    )
    assert extract(html, allow_reference=True) is None
