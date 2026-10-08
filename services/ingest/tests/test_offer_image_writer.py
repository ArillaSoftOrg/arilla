"""`offer_image` yazimi: idempotent, sira degisimi, kaldirma, yasam dongusu (karar 0073)."""

from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime

import psycopg
import pytest

from collect.images import SourceImage, select_images
from collect.records import NormalizedOffer
from collect.writer import OfferWriter
from db.connection import database_url

pytestmark = pytest.mark.integration

DOMAIN = "test-offer-gallery.example"


def _owner() -> psycopg.Connection:
    return psycopg.connect(database_url("DATABASE_URL_OWNER"))


def _cleanup(cur: psycopg.Cursor) -> None:
    cur.execute(
        """DELETE FROM price_point WHERE offer_id IN (
             SELECT o.id FROM offer o JOIN merchant m ON m.id = o.merchant_id
              WHERE m.domain = %s)""",
        (DOMAIN,),
    )
    cur.execute(
        "DELETE FROM offer WHERE merchant_id IN (SELECT id FROM merchant WHERE domain = %s)",
        (DOMAIN,),
    )
    cur.execute("DELETE FROM merchant WHERE domain = %s", (DOMAIN,))


@pytest.fixture
def conn_and_merchant() -> Iterator[tuple[psycopg.Connection, int]]:
    try:
        owner = _owner()
    except psycopg.OperationalError as error:  # pragma: no cover
        pytest.skip(f"yerel veritabani yok: {error}")
    with owner:
        with owner.cursor() as cur:
            _cleanup(cur)
            cur.execute(
                """INSERT INTO merchant (slug, name, domain, source_type)
                   VALUES ('test-offer-gallery', 'Test', %s, 'shopify') RETURNING id""",
                (DOMAIN,),
            )
            row = cur.fetchone()
        owner.commit()
        assert row is not None
        yield owner, int(row[0])
        owner.rollback()
        with owner.cursor() as cur:
            _cleanup(cur)
        owner.commit()


def _offer(urls: list[str], **kw) -> NormalizedOffer:
    candidates = [SourceImage(u, i + 1) for i, u in enumerate(urls)]
    return NormalizedOffer(
        external_id="p-1",
        url="https://shop.example/p",
        title_raw="Urun",
        current_price=10000,
        list_price=None,
        in_stock=True,
        currency="TRY",
        image_url=urls[0] if urls else None,
        images=tuple(select_images(candidates)),
        **kw,
    )


def _write(conn, merchant_id, offer) -> int:
    writer = OfferWriter(conn, merchant_id, datetime(2026, 10, 7, tzinfo=UTC))
    offer_id = writer.write(offer)
    conn.commit()
    return offer_id


def _rows(conn, offer_id):
    with conn.cursor() as cur:
        cur.execute(
            """SELECT right(source_url, 5), source_position, display_rank, status
                 FROM offer_image WHERE offer_id = %s ORDER BY source_position, id""",
            (offer_id,),
        )
        return cur.fetchall()


def _urls(*names: str) -> list[str]:
    return [f"https://cdn.example/{n}.jpg" for n in names]


def test_writes_gallery_rows(conn_and_merchant) -> None:
    conn, mid = conn_and_merchant
    offer_id = _write(conn, mid, _offer(_urls("a", "b", "c", "d")))
    assert _rows(conn, offer_id) == [
        ("a.jpg", 0, 0, "active"),
        ("b.jpg", 1, 1, "active"),
        ("c.jpg", 2, 2, "active"),
        ("d.jpg", 3, None, "active"),
    ]


def test_reingest_creates_no_duplicates_and_no_updates(conn_and_merchant) -> None:
    conn, mid = conn_and_merchant
    offer = _offer(_urls("a", "b", "c"))
    offer_id = _write(conn, mid, offer)
    with conn.cursor() as cur:
        cur.execute(
            "SELECT id, xmin::text FROM offer_image WHERE offer_id = %s ORDER BY id", (offer_id,)
        )
        before = cur.fetchall()
    assert _write(conn, mid, offer) == offer_id
    with conn.cursor() as cur:
        cur.execute(
            "SELECT id, xmin::text FROM offer_image WHERE offer_id = %s ORDER BY id", (offer_id,)
        )
        after = cur.fetchall()
    assert before == after  # ayni satirlar, ayni surum: degisim yoksa UPDATE yok


def test_same_image_with_new_version_param_updates_in_place(conn_and_merchant) -> None:
    conn, mid = conn_and_merchant
    offer_id = _write(conn, mid, _offer(["https://cdn.shopify.com/s/a.jpg?v=1"]))
    _write(conn, mid, _offer(["https://cdn.shopify.com/s/a.jpg?v=2"]))
    with conn.cursor() as cur:
        cur.execute(
            "SELECT count(*), max(source_url) FROM offer_image WHERE offer_id = %s", (offer_id,)
        )
        assert cur.fetchone() == (1, "https://cdn.shopify.com/s/a.jpg?v=2")


def test_source_order_change_updates_positions_without_unique_violation(conn_and_merchant) -> None:
    conn, mid = conn_and_merchant
    offer_id = _write(conn, mid, _offer(_urls("a", "b", "c")))
    # b ve c yer degistirir; display_rank 1<->2 ayni ifadede takas edilir.
    _write(conn, mid, _offer(_urls("a", "c", "b")))
    assert _rows(conn, offer_id) == [
        ("a.jpg", 0, 0, "active"),
        ("c.jpg", 1, 1, "active"),
        ("b.jpg", 2, 2, "active"),
    ]


def test_primary_change_moves_rank_zero(conn_and_merchant) -> None:
    conn, mid = conn_and_merchant
    offer_id = _write(conn, mid, _offer(_urls("a", "b")))
    _write(conn, mid, _offer(_urls("b", "a")))
    assert _rows(conn, offer_id) == [("b.jpg", 0, 0, "active"), ("a.jpg", 1, 1, "active")]


def test_removed_source_image_is_kept_as_removed_and_not_displayed(conn_and_merchant) -> None:
    conn, mid = conn_and_merchant
    offer_id = _write(conn, mid, _offer(_urls("a", "b", "c")))
    _write(conn, mid, _offer(_urls("a", "c")))
    rows = {r[0]: r for r in _rows(conn, offer_id)}
    assert rows["b.jpg"][2] is None
    assert rows["b.jpg"][3] == "removed"  # silinmedi
    assert rows["a.jpg"][3] == "active" and rows["c.jpg"][3] == "active"


def test_removed_image_that_returns_is_reactivated(conn_and_merchant) -> None:
    conn, mid = conn_and_merchant
    offer_id = _write(conn, mid, _offer(_urls("a", "b")))
    _write(conn, mid, _offer(_urls("a")))
    _write(conn, mid, _offer(_urls("a", "b")))
    assert _rows(conn, offer_id) == [("a.jpg", 0, 0, "active"), ("b.jpg", 1, 1, "active")]
    with conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM offer_image WHERE offer_id = %s", (offer_id,))
        assert cur.fetchone() == (2,)


def test_source_with_no_images_marks_existing_removed(conn_and_merchant) -> None:
    conn, mid = conn_and_merchant
    offer_id = _write(conn, mid, _offer(_urls("a")))
    _write(conn, mid, _offer([]))
    assert _rows(conn, offer_id) == [("a.jpg", 0, None, "removed")]


def test_ten_images_store_six_and_display_three(conn_and_merchant) -> None:
    conn, mid = conn_and_merchant
    offer_id = _write(conn, mid, _offer(_urls(*"abcdefghij")))
    rows = _rows(conn, offer_id)
    assert len(rows) == 6
    assert sum(1 for r in rows if r[2] is not None) == 3


def test_mirror_columns_are_untouched_by_reingest(conn_and_merchant) -> None:
    conn, mid = conn_and_merchant
    offer = _offer(_urls("a", "b"))
    offer_id = _write(conn, mid, offer)
    with conn.cursor() as cur:
        cur.execute(
            """UPDATE offer_image SET r2_url = 'https://media.example/products/x.webp',
                      image_hash = 'abc' WHERE offer_id = %s AND source_position = 0""",
            (offer_id,),
        )
    conn.commit()
    _write(conn, mid, _offer(_urls("b", "a")))  # a artik 1. sirada
    with conn.cursor() as cur:
        cur.execute(
            "SELECT r2_url, image_hash FROM offer_image "
            "WHERE offer_id = %s AND right(source_url, 5) = 'a.jpg'",
            (offer_id,),
        )
        assert cur.fetchone() == ("https://media.example/products/x.webp", "abc")


def test_broken_image_is_not_resurrected(conn_and_merchant) -> None:
    conn, mid = conn_and_merchant
    offer = _offer(_urls("a", "b"))
    offer_id = _write(conn, mid, offer)
    with conn.cursor() as cur:
        cur.execute(
            """UPDATE offer_image SET status = 'broken', display_rank = NULL
                WHERE offer_id = %s AND source_position = 1""",
            (offer_id,),
        )
    conn.commit()
    _write(conn, mid, offer)
    assert dict((r[0], r[3]) for r in _rows(conn, offer_id))["b.jpg"] == "broken"


def test_database_rejects_duplicate_rank_and_bad_rows(conn_and_merchant) -> None:
    conn, mid = conn_and_merchant
    offer_id = _write(conn, mid, _offer(_urls("a", "b")))
    with pytest.raises(psycopg.errors.UniqueViolation):
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE offer_image SET display_rank = 0 "
                "WHERE offer_id = %s AND source_position = 1",
                (offer_id,),
            )
        conn.commit()  # ertelenmis kisit COMMIT'te kontrol edilir
    conn.rollback()
    with pytest.raises(psycopg.errors.CheckViolation), conn.cursor() as cur:
        cur.execute(
            "UPDATE offer_image SET status = 'removed' "
            "WHERE offer_id = %s AND display_rank = 0",
            (offer_id,),
        )
    conn.rollback()


def test_corrective_reingest_replaces_flat_legacy_primary_without_duplicates(
    conn_and_merchant,
) -> None:
    """Eski surum yalniz duz urun gorselini rank 0 yazdi (tek gorsel/backfill A).
    Model-oncelikli ingest ayni offer'i duzeltir: satir cogalmaz, duz gorsel
    gosterimden cikar, offer.image_url ve galeri[0] tutarli olur."""
    conn, mid = conn_and_merchant
    flat = "https://cdn.example/flat.jpg"
    offer_id = _write(conn, mid, _offer([flat]))
    assert _rows(conn, offer_id) == [("t.jpg", 0, 0, "active")]

    corrected = _offer(_urls("m1", "m2", "m3", "m4") + [flat])
    _write(conn, mid, corrected)
    rows = {r[0]: r for r in _rows(conn, offer_id)}
    assert len(rows) == 5
    assert rows["1.jpg"][2] == 0 and rows["2.jpg"][2] == 1 and rows["3.jpg"][2] == 2
    assert rows["t.jpg"][2] is None
    with conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM offer_image WHERE offer_id = %s", (offer_id,))
        assert cur.fetchone() == (5,)
    _write(conn, mid, corrected)  # ikinci kosu: degisiklik yok
    assert len(_rows(conn, offer_id)) == 5
