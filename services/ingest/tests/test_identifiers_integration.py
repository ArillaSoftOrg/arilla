"""Varyant barkodu: zenginlestirme -> kalicilik -> eslestirme (0036).

Ag yok: `/products/<handle>.js` ve `robots.txt` sahte tasima ile gelir.
Yerel veritabani gerektirir.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from datetime import UTC, datetime

import httpx
import psycopg
import pytest

from collect import identifiers
from collect.link.robots import RobotsCache
from collect.records import NormalizedOffer, NormalizedVariant
from collect.writer import OfferWriter
from db.connection import database_url
from resolve.pipeline import resolve_offers

pytestmark = pytest.mark.integration

HOCL_60 = "8809447257433"
HOCL_100 = "8809447257440"
OTHER_50 = "8809447257112"  # gecerli ama baska bir urun/boyut
BRAND = "Testvaryant"
DOMAINS = ("test-varyant-a.example", "test-varyant-b.example")
TITLE = f"{BRAND} Rapid Rescue Mist"


def _owner() -> psycopg.Connection:
    return psycopg.connect(database_url("DATABASE_URL_OWNER"))


def _cleanup(cur: psycopg.Cursor) -> None:
    offers = """SELECT o.id FROM offer o JOIN merchant m ON m.id = o.merchant_id
                 WHERE m.domain = ANY(%(d)s)"""
    cur.execute(
        f"""CREATE TEMP TABLE IF NOT EXISTS _tp AS
            SELECT DISTINCT product_id FROM offer WHERE id IN ({offers})""",
        {"d": list(DOMAINS)},
    )
    cur.execute(f"DELETE FROM match_candidate WHERE offer_id IN ({offers})", {"d": list(DOMAINS)})
    cur.execute(f"DELETE FROM price_point WHERE offer_id IN ({offers})", {"d": list(DOMAINS)})
    cur.execute(f"DELETE FROM offer WHERE id IN ({offers})", {"d": list(DOMAINS)})
    cur.execute("DELETE FROM product WHERE id IN (SELECT product_id FROM _tp)")
    cur.execute("DROP TABLE _tp")
    cur.execute("DELETE FROM merchant WHERE domain = ANY(%s)", (list(DOMAINS),))
    cur.execute("DELETE FROM brand WHERE name = %s", (BRAND,))


def _offer(external_id: str, title: str, variants=(), sku: str | None = None) -> NormalizedOffer:
    attributes = {"id": external_id}
    if sku:
        attributes["sku"] = sku
    return NormalizedOffer(
        external_id=external_id,
        url=f"https://{DOMAINS[0]}/products/mist",
        title_raw=title,
        current_price=100000,
        list_price=None,
        in_stock=True,
        brand_raw=BRAND,
        currency="TRY",
        attributes_raw=attributes,
        variants=tuple(variants),
    )


MULTI_SIZE = _offer(
    "A1",
    TITLE,
    variants=[
        NormalizedVariant("101", "60ml", "60ml", True, sku="K60"),
        NormalizedVariant("102", "100ml", "100ml", True, sku="K100"),
    ],
)


def _write(conn: psycopg.Connection, merchant_id: int, offer: NormalizedOffer, url=None) -> int:
    if url:
        offer = NormalizedOffer(**{**offer.__dict__, "url": url})
    return OfferWriter(conn, merchant_id=merchant_id, observed_at=datetime.now(UTC)).write(offer)


@pytest.fixture
def merchants() -> Iterator[tuple[int, int]]:
    try:
        owner = _owner()
    except psycopg.OperationalError as error:  # pragma: no cover
        pytest.skip(f"yerel veritabani yok: {error}")
    with owner:
        with owner.cursor() as cur:
            _cleanup(cur)
            ids = []
            for index, domain in enumerate(DOMAINS):
                cur.execute(
                    """INSERT INTO merchant (slug, name, domain, source_type, feed_config)
                       VALUES (%s, %s, %s, 'shopify', %s) RETURNING id""",
                    (
                        f"test-varyant-{index}",
                        f"Test {index}",
                        domain,
                        json.dumps({"bootstrap_source": "bootstrap_shopify"}),
                    ),
                )
                ids.append(int(cur.fetchone()[0]))
        owner.commit()
        yield ids[0], ids[1]
        with owner.cursor() as cur:
            _cleanup(cur)
        owner.commit()


def _client(calls: list[str]) -> httpx.Client:
    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.path)
        if request.url.path == "/robots.txt":
            return httpx.Response(404)
        return httpx.Response(
            200,
            json={
                "options": ["Size"],
                "variants": [
                    {"id": 101, "option1": "60ml", "sku": "K60", "barcode": HOCL_60},
                    {"id": 102, "option1": "100ml", "sku": "K100", "barcode": HOCL_100},
                ],
            },
        )

    return httpx.Client(transport=httpx.MockTransport(handler))


def _enrich(conn: psycopg.Connection, calls: list[str]) -> identifiers.IdentifierReport:
    client = _client(calls)
    return identifiers.enrich_merchant(
        conn, "test-varyant-0", client=client, robots=RobotsCache(client=client)
    )


def _method(conn: psycopg.Connection, offer_id: int) -> tuple[str | None, int | None]:
    row = conn.execute(
        """SELECT mc.method, o.product_id FROM offer o
             LEFT JOIN match_candidate mc ON mc.offer_id = o.id
            WHERE o.id = %s""",
        (offer_id,),
    ).fetchone()
    return (row[0], row[1]) if row else (None, None)


def test_variant_barcodes_enrich_persist_and_match(merchants: tuple[int, int], monkeypatch) -> None:
    monkeypatch.setattr(identifiers.time, "sleep", lambda _: None)
    merchant_a, merchant_b = merchants
    calls: list[str] = []
    with _owner() as conn:
        multi = _write(conn, merchant_a, MULTI_SIZE)
        # B tarafi: ayni aile, ayri listeler; barkod SKU'da (Vionine gibi).
        b_100 = _write(
            conn,
            merchant_b,
            _offer("B100", f"{TITLE} 100 ml", sku=HOCL_100),
            url=f"https://{DOMAINS[1]}/products/m100",
        )
        b_60 = _write(
            conn,
            merchant_b,
            _offer("B60", f"{TITLE} 60 ml", sku=HOCL_60),
            url=f"https://{DOMAINS[1]}/products/m60",
        )
        b_50 = _write(
            conn,
            merchant_b,
            _offer("B50", f"{TITLE} 50 ml", sku=OTHER_50),
            url=f"https://{DOMAINS[1]}/products/m50",
        )
        # Barkodsuz kaynak: metin yolu.
        b_plain = _write(
            conn,
            merchant_b,
            _offer("BX", f"{TITLE} Mist"),
            url=f"https://{DOMAINS[1]}/products/plain",
        )
        conn.commit()

        # 1. Zenginlestirme: her boyut satiri kendi barkodu; offer duzeyi YOK.
        first = _enrich(conn, calls)
        assert first.requests == 1 and first.variant_gtins == 2
        rows = dict(
            conn.execute(
                "SELECT size_label, gtin FROM offer_variant WHERE offer_id = %s", (multi,)
            ).fetchall()
        )
        assert rows == {"60ml": HOCL_60, "100ml": HOCL_100}
        attrs = conn.execute("SELECT attributes_raw FROM offer WHERE id = %s", (multi,)).fetchone()[
            0
        ]
        assert "gtin" not in attrs and "identifiers_checked_at" in attrs

        # 2. Idempotent: taze -> istek yok, satir/ barkod cogalmaz.
        second = _enrich(conn, calls)
        assert second.requests == 0 and second.skipped_fresh == 1
        assert (
            conn.execute(
                "SELECT count(*) FROM offer_variant WHERE offer_id = %s", (multi,)
            ).fetchone()[0]
            == 2
        )

        # 3. Yeniden toplama barkodlari ve tazelik isaretini silmez.
        _write(conn, merchant_a, MULTI_SIZE)
        conn.commit()
        assert (
            conn.execute(
                "SELECT count(gtin) FROM offer_variant WHERE offer_id = %s", (multi,)
            ).fetchone()[0]
            == 2
        )
        attrs = conn.execute("SELECT attributes_raw FROM offer WHERE id = %s", (multi,)).fetchone()[
            0
        ]
        assert "identifiers_checked_at" in attrs

        # SKU barkodlari (B tarafi, ag yok).
        assert identifiers.enrich_from_sku(conn, "test-varyant-1") == 3
        conn.commit()

        # 4. Eslestirme: once cok boyutlu offer urun olur, sonra B.
        resolve_offers(conn, merchant_id=merchant_a)
        resolve_offers(conn, merchant_id=merchant_b)
        conn.commit()
        product = _method(conn, multi)[1]

        # Ayni boyut + ayni barkod: kesin eslesme (60 ve 100 ayri listeler,
        # ayni merchant olsalar da barkod kimligi kanitlar).
        assert _method(conn, b_100) == ("gtin", product)
        assert _method(conn, b_60) == ("gtin", product)
        # Ayni aile, baska gecerli barkod: urunun tam barkod kumesinde yok -> ayri urun.
        assert _method(conn, b_50)[1] != product
        # Barkodsuz kaynak barkodla eslesmez; metin yoluna duser.
        method, _ = _method(conn, b_plain)
        assert method in {None, "text", "hybrid"}
