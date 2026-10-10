"""Basligi/markasi/kategorisi degisen offer'in eski METIN vektoru kalmaz (AI denetimi A8).

`enrich` embedding'i olan offer'i bir daha secmiyor; gorsel icin bu zaten
cozulmustu (`test_writer_image_change.py`), metin icin yoktu: baslik degisince
vektor eski metinde kaliyor, benzerlik kenarlari sapiyordu. Ama fiyat degisimi
ya da kanonik metni degistirmeyen gurultu eki (ornegin "Kampanyali") vektoru
SILMEMELI: gereksiz yeniden embedding gereksiz API maliyetidir.
"""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import replace
from datetime import UTC, datetime

import psycopg
import pytest

from collect.records import NormalizedOffer
from collect.writer import OfferWriter
from db.connection import database_url
from similarity.vectors import to_literal

pytestmark = pytest.mark.integration

DOMAIN = "test-metin-degisimi.example"


def _owner() -> psycopg.Connection:
    return psycopg.connect(database_url("DATABASE_URL_OWNER"))


def _cleanup(cur: psycopg.Cursor) -> None:
    cur.execute(
        """DELETE FROM embedding WHERE target_type = 'offer' AND target_id IN (
             SELECT o.id FROM offer o JOIN merchant m ON m.id = o.merchant_id
              WHERE m.domain = %s)""",
        (DOMAIN,),
    )
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
def merchant_id() -> Iterator[int]:
    try:
        owner = _owner()
    except psycopg.OperationalError as error:  # pragma: no cover
        pytest.skip(f"yerel veritabani yok: {error}")
    with owner:
        with owner.cursor() as cur:
            _cleanup(cur)
            cur.execute(
                """INSERT INTO merchant (slug, name, domain, source_type)
                   VALUES ('test-metin-degisimi', 'Test', %s, 'shopify') RETURNING id""",
                (DOMAIN,),
            )
            row = cur.fetchone()
        owner.commit()
        assert row is not None
        yield int(row[0])
        with owner.cursor() as cur:
            _cleanup(cur)
        owner.commit()


OFFER = NormalizedOffer(
    external_id="t1",
    url=f"https://{DOMAIN}/t1",
    title_raw="Deri Bilekli Bot",
    brand_raw="Kuzey",
    category_raw="moda/ayakkabi",
    current_price=100000,
    list_price=None,
    in_stock=True,
    image_url="https://cdn.example/a.jpg",
    currency="TRY",
)


def _text_embeddings(conn: psycopg.Connection, offer_id: int) -> int:
    row = conn.execute(
        """SELECT count(*) FROM embedding
            WHERE target_type = 'offer' AND target_id = %s AND kind = 'text'""",
        (offer_id,),
    ).fetchone()
    assert row is not None
    return int(row[0])


def _rewrite(conn: psycopg.Connection, merchant_id: int, offer: NormalizedOffer) -> OfferWriter:
    writer = OfferWriter(conn, merchant_id=merchant_id, observed_at=datetime.now(UTC))
    writer.write(offer)
    conn.commit()
    return writer


@pytest.fixture
def seeded(merchant_id: int) -> Iterator[tuple[psycopg.Connection, int, int]]:
    with _owner() as conn:
        first = OfferWriter(conn, merchant_id=merchant_id, observed_at=datetime.now(UTC))
        offer_id = first.write(OFFER)
        conn.execute(
            """INSERT INTO embedding (target_type, target_id, kind, model_version, vector)
               VALUES ('offer', %s, 'text', 'test', %s)""",
            (offer_id, to_literal([1.0] + [0.0] * 767)),
        )
        conn.commit()
        yield conn, merchant_id, offer_id


def test_price_change_keeps_the_text_vector(seeded) -> None:
    conn, merchant_id, offer_id = seeded
    writer = _rewrite(conn, merchant_id, replace(OFFER, current_price=90000))
    assert writer.counts.stale_text_embeddings == 0
    assert _text_embeddings(conn, offer_id) == 1


def test_noise_only_title_change_keeps_the_text_vector(seeded) -> None:
    conn, merchant_id, offer_id = seeded
    writer = _rewrite(conn, merchant_id, replace(OFFER, title_raw="Deri Bilekli Bot Kampanyali"))
    assert writer.counts.stale_text_embeddings == 0
    assert _text_embeddings(conn, offer_id) == 1


@pytest.mark.parametrize(
    "change",
    [
        {"title_raw": "Suet Bilekli Bot"},
        {"brand_raw": "Bambi"},
        {"category_raw": "moda/canta"},
    ],
    ids=["title", "brand", "category"],
)
def test_content_change_drops_the_stale_text_vector(seeded, change: dict) -> None:
    conn, merchant_id, offer_id = seeded
    writer = _rewrite(conn, merchant_id, replace(OFFER, **change))
    assert writer.counts.stale_text_embeddings == 1
    assert _text_embeddings(conn, offer_id) == 0


def test_a_new_offer_has_nothing_to_drop(merchant_id: int) -> None:
    with _owner() as conn:
        writer = _rewrite(conn, merchant_id, replace(OFFER, external_id="t2"))
    assert writer.counts.stale_text_embeddings == 0
