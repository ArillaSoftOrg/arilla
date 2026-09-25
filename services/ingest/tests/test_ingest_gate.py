"""Toplama kapisi (docs/decisions/0031).

Birim testleri kurallari; `integration` isaretliler boru hattinin gercek
veritabaninda reddi nasil kaydettigini sinar: `ingest_run` `failed` +
`refused:<kod>`, sifir offer, sifir `price_point`, magazaya sifir istek.
Hicbir test aga cikmaz.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import httpx
import psycopg
import pytest

from collect import __main__ as collect_cli
from collect.bootstrap import SHOPIFY_MAPPING
from collect.gate import ingest_refusal
from collect.pipeline import run_ingest
from collect.sources.shopify import ShopifyConnector
from db.connection import database_url

VERIFIED_SHOPIFY = {"currency": "TRY", "currency_verified": True}


def _merchant(source_type: str = "shopify", is_active: Any = True, **config: Any) -> dict:
    return {"source_type": source_type, "is_active": is_active, "feed_config": config}


# --- kurallar --------------------------------------------------------------------


@pytest.mark.parametrize("source_type", ["shopify", "xml_feed", "api"])
def test_inactive_merchant_is_refused_for_every_source(source_type: str) -> None:
    refusal = ingest_refusal(_merchant(source_type, is_active=False, **VERIFIED_SHOPIFY))

    assert refusal is not None
    assert refusal.code == "merchant_inactive"
    assert refusal.error_text.startswith("refused:merchant_inactive:")


@pytest.mark.parametrize(
    "config",
    [
        {"currency": "TRY", "currency_verified": False},
        {"currency": "TRY"},  # eksik
        {"currency": "TRY", "currency_verified": "true"},  # metin, JSON true degil
        {"currency": "TRY", "currency_verified": 1},
        {"currency": "TRY", "currency_verified": None},
    ],
)
def test_shopify_without_explicit_true_verification_is_refused(config: dict) -> None:
    refusal = ingest_refusal(_merchant(**config))

    assert refusal is not None
    assert refusal.code == "currency_unverified"


@pytest.mark.parametrize("currency", [None, "EUR", "try", "TL"])
def test_verified_shopify_must_be_exactly_try(currency: str | None) -> None:
    refusal = ingest_refusal(_merchant(currency=currency, currency_verified=True))

    assert refusal is not None
    assert refusal.code == "currency_not_try"


def test_shopify_feed_config_must_be_an_object() -> None:
    refusal = ingest_refusal({"source_type": "shopify", "is_active": True, "feed_config": "{}"})

    assert refusal is not None
    assert refusal.code == "feed_config_invalid"


def test_verified_active_shopify_passes() -> None:
    assert ingest_refusal(_merchant(**VERIFIED_SHOPIFY)) is None


def test_active_xml_merchant_needs_no_currency_flag() -> None:
    """Gate XML/API davranisini degistirmez: para birimi kaniti orada kayit
    duzeyinde (normalize, 0029) aranmaya devam eder."""
    assert ingest_refusal(_merchant("xml_feed")) is None


# --- boru hatti, yerel veritabani ---------------------------------------------------

SHOPIFY_SLUG = "test-gate-shopify"
XML_SLUG = "test-gate-xml"

CLEANUP_STATEMENTS = (
    """DELETE FROM variant_stock_event WHERE variant_id IN (
        SELECT v.id FROM offer_variant v
          JOIN offer o ON o.id = v.offer_id
          JOIN merchant m ON m.id = o.merchant_id
         WHERE m.slug = %(slug)s)""",
    """DELETE FROM offer_variant WHERE offer_id IN (
        SELECT o.id FROM offer o JOIN merchant m ON m.id = o.merchant_id
         WHERE m.slug = %(slug)s)""",
    """DELETE FROM price_point WHERE offer_id IN (
        SELECT o.id FROM offer o JOIN merchant m ON m.id = o.merchant_id
         WHERE m.slug = %(slug)s)""",
    "DELETE FROM offer WHERE merchant_id IN (SELECT id FROM merchant WHERE slug = %(slug)s)",
    "DELETE FROM ingest_run WHERE merchant_id IN (SELECT id FROM merchant WHERE slug = %(slug)s)",
    "DELETE FROM merchant WHERE slug = %(slug)s",
)

INSERT_MERCHANT = """
INSERT INTO merchant (slug, name, domain, source_type, feed_url, feed_config, is_active)
VALUES (%s, 'Test Kapi', %s, %s, %s, %s, %s)
RETURNING id
"""

COUNTS = """
SELECT (SELECT count(*) FROM offer WHERE merchant_id = %(id)s),
       (SELECT count(*) FROM price_point pp JOIN offer o ON o.id = pp.offer_id
         WHERE o.merchant_id = %(id)s)
"""

RUNS = """
SELECT status, error_text, offers_seen, offers_created, price_points_written, finished_at
  FROM ingest_run WHERE merchant_id = %s ORDER BY id
"""


def _owner() -> psycopg.Connection:
    try:
        return psycopg.connect(database_url("DATABASE_URL_OWNER"))
    except psycopg.OperationalError as error:  # pragma: no cover
        pytest.skip(f"yerel veritabani yok: {error}")


def _app() -> psycopg.Connection:
    return psycopg.connect(database_url("DATABASE_URL"))


def _cleanup(slug: str) -> None:
    with _owner() as owner, owner.cursor() as cur:
        for statement in CLEANUP_STATEMENTS:
            cur.execute(statement, {"slug": slug})


def _create(slug: str, source_type: str, feed_url: str, config: dict, is_active: bool) -> int:
    _cleanup(slug)
    with _owner() as owner, owner.cursor() as cur:
        cur.execute(
            INSERT_MERCHANT,
            (slug, f"{slug}.example", source_type, feed_url, json.dumps(config), is_active),
        )
        row = cur.fetchone()
        assert row is not None
        return int(row[0])


def _counts(merchant_id: int) -> tuple[int, int]:
    with _owner() as conn, conn.cursor() as cur:
        cur.execute(COUNTS, {"id": merchant_id})
        row = cur.fetchone()
        assert row is not None
        return int(row[0]), int(row[1])


def _runs(merchant_id: int) -> list[tuple[Any, ...]]:
    with _owner() as conn, conn.cursor() as cur:
        cur.execute(RUNS, (merchant_id,))
        return cur.fetchall()


def _shopify_config(**overrides: Any) -> dict:
    config = {
        "transport": {"pagination": {"size": 50}, "shopify": {"max_products": 2}},
        "mapping": SHOPIFY_MAPPING,
        "value_formats": {"decimal_separator": ".", "thousands_separator": ","},
        **VERIFIED_SHOPIFY,
    }
    config.update(overrides)
    return config


def _product(index: int) -> dict:
    return {
        "id": index,
        "handle": f"urun-{index}",
        "title": f"Test Urun {index}",
        "vendor": "Test",
        "product_type": "Test",
        "variants": [
            {"id": index * 10, "available": True, "price": "129.90", "compare_at_price": None}
        ],
        "images": [],
    }


@pytest.fixture
def shop_requests(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """Shopify connector'unun HER istegi buraya duser; aga cikis yok."""
    requests: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(str(request.url))
        page = int(request.url.params.get("page", 1))
        products = [_product(i) for i in range(1, 4)] if page == 1 else []
        return httpx.Response(200, json={"products": products})

    client = httpx.Client(transport=httpx.MockTransport(handler))
    monkeypatch.setattr(ShopifyConnector, "_client", lambda self: client)
    return requests


@pytest.fixture
def shopify_merchant() -> Iterator[Any]:
    created: list[str] = []

    def create(config: dict, is_active: bool = True) -> int:
        created.append(SHOPIFY_SLUG)
        return _create(
            SHOPIFY_SLUG,
            "shopify",
            f"https://{SHOPIFY_SLUG}.example/products.json",
            config,
            is_active,
        )

    yield create
    for slug in set(created):
        _cleanup(slug)


def _assert_refused(merchant_id: int, result: Any, code: str, shop_requests: list[str]) -> None:
    assert result.status == "failed"
    assert result.refusal == code
    assert result.offers_seen == 0
    assert result.counts.offers_created == 0
    assert result.counts.price_points_written == 0
    ((status, error_text, seen, created, points, finished_at),) = _runs(merchant_id)
    assert status == "failed"
    assert error_text.startswith(f"refused:{code}:")
    assert (seen, created, points) == (0, 0, 0)
    assert finished_at is not None
    assert _counts(merchant_id) == (0, 0)
    # Red, katalog uc noktasina gidilmeden verildi.
    assert shop_requests == []


@pytest.mark.integration
def test_unverified_active_shopify_is_refused_before_network(
    shopify_merchant: Any, shop_requests: list[str]
) -> None:
    merchant_id = shopify_merchant(_shopify_config(currency_verified=False))

    with _app() as conn:
        result = run_ingest(conn, SHOPIFY_SLUG)

    _assert_refused(merchant_id, result, "currency_unverified", shop_requests)


@pytest.mark.integration
def test_missing_currency_verified_is_refused(
    shopify_merchant: Any, shop_requests: list[str]
) -> None:
    config = _shopify_config()
    del config["currency_verified"]
    merchant_id = shopify_merchant(config)

    with _app() as conn:
        result = run_ingest(conn, SHOPIFY_SLUG)

    _assert_refused(merchant_id, result, "currency_unverified", shop_requests)


@pytest.mark.integration
def test_inactive_verified_shopify_is_refused(
    shopify_merchant: Any, shop_requests: list[str]
) -> None:
    merchant_id = shopify_merchant(_shopify_config(), is_active=False)

    with _app() as conn:
        result = run_ingest(conn, SHOPIFY_SLUG)

    _assert_refused(merchant_id, result, "merchant_inactive", shop_requests)


@pytest.mark.integration
def test_verified_active_shopify_proceeds_as_try_within_cap(
    shopify_merchant: Any, shop_requests: list[str]
) -> None:
    merchant_id = shopify_merchant(_shopify_config())

    with _app() as conn:
        result = run_ingest(conn, SHOPIFY_SLUG)

    assert result.status == "success"
    assert result.refusal is None
    # Magaza 3 urun sunuyor; tavan 2.
    assert result.counts.offers_created == 2
    assert _counts(merchant_id) == (2, 2)
    assert len(shop_requests) == 1
    with _owner() as conn, conn.cursor() as cur:
        cur.execute("SELECT DISTINCT currency FROM offer WHERE merchant_id = %s", (merchant_id,))
        assert cur.fetchall() == [("TRY",)]


@pytest.mark.integration
def test_cli_reports_refusal_and_exits_nonzero(
    shopify_merchant: Any, shop_requests: list[str], capsys: pytest.CaptureFixture[str]
) -> None:
    shopify_merchant(_shopify_config(currency_verified=False))

    code = collect_cli.main(["--merchant", SHOPIFY_SLUG])

    assert code == 1
    output = capsys.readouterr().out
    assert "status             failed" in output
    assert "refused            currency_unverified" in output
    assert shop_requests == []


@pytest.fixture
def xml_merchant(feed_v1: Path, xml_feed_config: dict) -> Iterator[Any]:
    def create(is_active: bool) -> int:
        return _create(XML_SLUG, "xml_feed", str(feed_v1), xml_feed_config, is_active)

    yield create
    _cleanup(XML_SLUG)


@pytest.mark.integration
def test_inactive_xml_merchant_is_refused(xml_merchant: Any) -> None:
    merchant_id = xml_merchant(is_active=False)

    with _app() as conn:
        result = run_ingest(conn, XML_SLUG)

    _assert_refused(merchant_id, result, "merchant_inactive", [])


@pytest.mark.integration
def test_active_xml_merchant_still_ingests(xml_merchant: Any) -> None:
    merchant_id = xml_merchant(is_active=True)

    with _app() as conn:
        result = run_ingest(conn, XML_SLUG)

    assert result.status == "success"
    assert result.refusal is None
    assert _counts(merchant_id) == (100, 100)
