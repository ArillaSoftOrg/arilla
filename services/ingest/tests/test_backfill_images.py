"""Backfill A: dry-run yazmaz, apply yalniz gorseli olmayan offer'lara yazar (karar 0073)."""

from __future__ import annotations

from collections.abc import Iterator

import psycopg
import pytest

from collect.backfill_images import backfill
from db.connection import database_url

pytestmark = pytest.mark.integration

DOMAIN = "test-backfill-gallery.example"


@pytest.fixture
def conn() -> Iterator[psycopg.Connection]:
    try:
        owner = psycopg.connect(database_url("DATABASE_URL_OWNER"))
    except psycopg.OperationalError as error:  # pragma: no cover
        pytest.skip(f"yerel veritabani yok: {error}")

    def clean() -> None:
        owner.rollback()
        with owner.cursor() as cur:
            cur.execute(
                "DELETE FROM offer WHERE merchant_id IN "
                "(SELECT id FROM merchant WHERE domain = %s)",
                (DOMAIN,),
            )
            cur.execute("DELETE FROM merchant WHERE domain = %s", (DOMAIN,))
        owner.commit()

    clean()
    with owner.cursor() as cur:
        cur.execute(
            "INSERT INTO merchant (slug, name, domain, source_type) "
            "VALUES ('test-backfill-gallery', 'T', %s, 'shopify') RETURNING id",
            (DOMAIN,),
        )
        merchant_id = cur.fetchone()[0]
        for ext, image in (
            ("a", "https://cdn.example/a.jpg"),
            ("b", "https://cdn.example/b.jpg"),
            ("c", "https://cdn.example/c.jpg"),
            ("d", None),
        ):
            cur.execute(
                "INSERT INTO offer (merchant_id, external_id, url, title_raw, image_url, currency) "
                "VALUES (%s, %s, 'https://x.example', 'T', %s, 'TRY')",
                (merchant_id, ext, image),
            )
    owner.commit()
    yield owner
    clean()
    owner.close()


def _count(conn: psycopg.Connection) -> int:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT count(*) FROM offer_image oi JOIN offer o ON o.id = oi.offer_id "
            "JOIN merchant m ON m.id = o.merchant_id WHERE m.domain = %s",
            (DOMAIN,),
        )
        return cur.fetchone()[0]


def test_dry_run_writes_nothing(conn) -> None:
    result = backfill(conn, apply=False, batch_size=2)
    assert result.rows_written == 0
    assert _count(conn) == 0


def test_apply_writes_rank_zero_once_and_is_resumable(conn) -> None:
    backfill(conn, apply=True, batch_size=2)
    assert _count(conn) == 3  # image_url'si olmayan offer atlanir
    with conn.cursor() as cur:
        cur.execute(
            "SELECT DISTINCT display_rank, source_position, status FROM offer_image oi "
            "JOIN offer o ON o.id = oi.offer_id JOIN merchant m ON m.id = o.merchant_id "
            "WHERE m.domain = %s",
            (DOMAIN,),
        )
        assert cur.fetchall() == [(0, 0, "active")]
    again = backfill(conn, apply=True, batch_size=2)
    assert again.rows_written == 0
    assert _count(conn) == 3


def test_existing_gallery_is_never_overwritten(conn) -> None:
    with conn.cursor() as cur:
        cur.execute(
            """INSERT INTO offer_image
                      (offer_id, url_hash, source_url, source_position, display_rank)
               SELECT o.id, decode(md5('x'), 'hex'), 'https://cdn.example/rich.jpg', 0, 0
                 FROM offer o JOIN merchant m ON m.id = o.merchant_id
                WHERE m.domain = %s AND o.external_id = 'a'""",
            (DOMAIN,),
        )
    conn.commit()
    backfill(conn, apply=True)
    with conn.cursor() as cur:
        cur.execute(
            "SELECT source_url, status FROM offer_image oi JOIN offer o ON o.id = oi.offer_id "
            "JOIN merchant m ON m.id = o.merchant_id WHERE m.domain = %s AND o.external_id = 'a'",
            (DOMAIN,),
        )
        assert cur.fetchall() == [("https://cdn.example/rich.jpg", "active")]
