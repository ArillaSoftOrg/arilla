"""Yeni urun acarken kategori baglama. Veritabani yok: sahte baglanti."""

from __future__ import annotations

from resolve import products


class _Cursor:
    def __init__(self, paths: dict[str, int]) -> None:
        self.paths = paths
        self.row: tuple | None = None

    def __enter__(self) -> _Cursor:
        return self

    def __exit__(self, *_: object) -> None:
        return None

    def execute(self, sql: str, params: dict | None = None) -> None:
        self.row = None
        if sql == products.INSERT_PRODUCT and params is not None:
            self.row = (params["category_id"],)
        elif sql == products.FIND_CATEGORY and params is not None:
            found = self.paths.get(params["path"])
            self.row = (found,) if found is not None else None

    def fetchone(self) -> tuple | None:
        return self.row


class _Conn:
    def __init__(self, paths: dict[str, int]) -> None:
        self.paths = paths

    def cursor(self) -> _Cursor:
        return _Cursor(self.paths)


def test_raw_category_wins_when_it_is_a_known_path() -> None:
    conn = _Conn({"moda": 1, "ev-yasam": 2})
    assert products.resolve_category(conn, "moda") == 1


def test_free_text_category_falls_back_to_merchant_hint(monkeypatch) -> None:
    monkeypatch.setattr(products, "resolve_brand", lambda conn, name: None)
    monkeypatch.setattr(products, "unique_slug", lambda conn, base: base)
    conn = _Conn({"ev-yasam": 2})

    product_id = products.create_from_offer(
        conn,
        title="Seramik Vazo",
        brand=None,
        category_path="Vazo & Dekor",  # Shopify product_type: agacta yok
        fallback_category_path="ev-yasam",
        image_url=None,
        gtin=None,
        mpn=None,
    )

    # Sahte INSERT, yazilan category_id'yi urun kimligi olarak geri dondurur.
    assert product_id == 2


def test_unknown_hint_never_opens_a_category() -> None:
    conn = _Conn({"moda": 1})
    assert products.resolve_category(conn, "yeni-kategori") is None
    assert products.resolve_category(conn, None) is None


def test_slug_includes_color_when_title_does_not() -> None:
    """Shopify renk kardesleri ayni basligi tasir; slug renkle ayrisir (0029)."""
    base = products.slug_base(
        title="North Tech Regular Fit Tişört", brand="North Sails", color="deniz-laciverti"
    )
    assert products.slugify(base) == "north-sails-north-tech-regular-fit-tisort-deniz-laciverti"


def test_slug_does_not_repeat_color_already_in_title() -> None:
    base = products.slug_base(title="Kadın Siyah Omuz Çantası", brand="Derimod", color="siyah")
    assert products.slugify(base) == "derimod-kadin-siyah-omuz-cantasi"
    assert products.slug_base(title="Vazo", brand=None, color=None) == "Vazo"
