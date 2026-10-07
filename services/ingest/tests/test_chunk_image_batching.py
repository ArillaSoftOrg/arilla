"""Chunk'li toplamada gorsel yazimi (karar 0073 x 0068): chunk basina TEK ifade,
chunk islemiyle atomik, yeniden yazimda idempotent."""

from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime

import psycopg
import pytest

import collect.writer as writer_module
from collect.images import SourceImage, select_images
from collect.records import NormalizedOffer
from collect.writer import OfferWriter
from db.connection import database_url

pytestmark = pytest.mark.integration

DOMAIN = "test-chunk-gallery.example"


@pytest.fixture
def conn_and_merchant() -> Iterator[tuple[psycopg.Connection, int]]:
    try:
        owner = psycopg.connect(database_url("DATABASE_URL_OWNER"))
    except psycopg.OperationalError as error:  # pragma: no cover
        pytest.skip(f"yerel veritabani yok: {error}")

    def clean() -> None:
        owner.rollback()
        with owner.cursor() as cur:
            cur.execute(
                "DELETE FROM price_point WHERE offer_id IN (SELECT o.id FROM offer o "
                "JOIN merchant m ON m.id = o.merchant_id WHERE m.domain = %s)",
                (DOMAIN,),
            )
            cur.execute(
                "DELETE FROM offer WHERE merchant_id IN "
                "(SELECT id FROM merchant WHERE domain = %s)",
                (DOMAIN,),
            )
            cur.execute("DELETE FROM product WHERE slug LIKE 'test-chunk-gallery-%'")
            cur.execute("DELETE FROM merchant WHERE domain = %s", (DOMAIN,))
        owner.commit()

    clean()
    with owner.cursor() as cur:
        cur.execute(
            "INSERT INTO merchant (slug, name, domain, source_type) "
            "VALUES ('test-chunk-gallery', 'T', %s, 'shopify') RETURNING id",
            (DOMAIN,),
        )
        merchant_id = int(cur.fetchone()[0])
    owner.commit()
    yield owner, merchant_id
    clean()
    owner.close()


def _offer(n: int, images: int = 4) -> NormalizedOffer:
    urls = [f"https://cdn.example/{n}/{i}.jpg" for i in range(images)]
    return NormalizedOffer(
        external_id=f"p-{n}",
        url="https://shop.example/p",
        title_raw="Urun",
        current_price=10000,
        list_price=None,
        in_stock=True,
        currency="TRY",
        image_url=urls[0],
        images=tuple(select_images([SourceImage(u, i + 1) for i, u in enumerate(urls)])),
    )


def _count(conn: psycopg.Connection) -> int:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT count(*) FROM offer_image oi JOIN offer o ON o.id = oi.offer_id "
            "JOIN merchant m ON m.id = o.merchant_id WHERE m.domain = %s",
            (DOMAIN,),
        )
        return int(cur.fetchone()[0])


def test_chunk_writes_all_offers_images_in_one_statement(conn_and_merchant, monkeypatch) -> None:
    conn, merchant_id = conn_and_merchant
    calls: list[int] = []
    real = writer_module.write_offer_images

    def counting(connection, items):
        calls.append(len(items))
        return real(connection, items)

    monkeypatch.setattr(writer_module, "write_offer_images", counting)
    writer = OfferWriter(conn, merchant_id, datetime(2026, 10, 7, tzinfo=UTC))
    writer.write_batch([_offer(n) for n in range(25)])
    conn.commit()
    assert calls == [25]  # 25 offer, 100 gorsel -> tek cagri
    assert _count(conn) == 100
    assert writer.counts.images_written == 100


def test_rollback_of_a_chunk_rolls_back_its_images(conn_and_merchant) -> None:
    conn, merchant_id = conn_and_merchant
    writer = OfferWriter(conn, merchant_id, datetime(2026, 10, 7, tzinfo=UTC))
    writer.write_batch([_offer(n) for n in range(5)])
    conn.rollback()  # pipeline: chunk hatasi -> rollback
    assert _count(conn) == 0


def test_resume_rewrite_of_a_committed_chunk_is_idempotent(conn_and_merchant) -> None:
    conn, merchant_id = conn_and_merchant
    offers = [_offer(n) for n in range(10)]
    observed = datetime(2026, 10, 7, tzinfo=UTC)
    OfferWriter(conn, merchant_id, observed).write_batch(offers)
    conn.commit()
    again = OfferWriter(conn, merchant_id, observed)
    again.write_batch(offers)
    conn.commit()
    assert _count(conn) == 40
    assert again.counts.images_written == 0  # degisim yok -> UPDATE yok
    assert again.counts.images_removed == 0


def test_duplicate_external_id_in_chunk_last_wins(conn_and_merchant) -> None:
    conn, merchant_id = conn_and_merchant
    writer = OfferWriter(conn, merchant_id, datetime(2026, 10, 7, tzinfo=UTC))
    writer.write_batch([_offer(1, images=4), _offer(1, images=2)])
    conn.commit()
    assert _count(conn) == 2


def test_chunk_syncs_product_primary_image_with_one_statement(
    conn_and_merchant, monkeypatch
) -> None:
    import collect.primary_image_sync as sync_module

    conn, merchant_id = conn_and_merchant
    observed = datetime(2026, 10, 7, tzinfo=UTC)
    first = [_offer(n) for n in range(3)]
    OfferWriter(conn, merchant_id, observed).write_batch(first)
    with conn.cursor() as cur:
        cur.execute(
            "SELECT id, image_url FROM offer o WHERE o.merchant_id = %s ORDER BY o.external_id",
            (merchant_id,),
        )
        offers = cur.fetchall()
        for offer_id, image_url in offers:
            cur.execute(
                "INSERT INTO product (slug, title, primary_image_url) "
                "VALUES (%s, 'P', %s) RETURNING id",
                (f"test-chunk-gallery-{offer_id}", image_url),
            )
            cur.execute(
                "UPDATE offer SET product_id = %s WHERE id = %s", (cur.fetchone()[0], offer_id)
            )
    conn.commit()

    calls: list[int] = []
    real = sync_module.sync_primary_images

    def counting(connection, merchant, items):
        calls.append(len(items))
        return real(connection, merchant, items)

    monkeypatch.setattr(writer_module, "sync_primary_images", counting)
    changed = [
        NormalizedOffer(**{**o.__dict__, "image_url": o.image_url.replace(".jpg", "-v2.jpg")})
        for o in first
    ]
    writer = OfferWriter(conn, merchant_id, observed)
    writer.write_batch(changed)
    conn.commit()
    assert calls == [3]
    assert writer.counts.primary_images_synced == 3
    with conn.cursor() as cur:
        cur.execute(
            "SELECT count(*) FROM product WHERE slug LIKE 'test-chunk-gallery-%%' "
            "AND primary_image_url LIKE '%%-v2.jpg'"
        )
        assert cur.fetchone()[0] == 3
