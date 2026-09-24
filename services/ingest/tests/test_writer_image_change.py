"""Gorseli degisen offer'in eski vektoru kalmaz (0029).

`enrich` embedding'i olan offer'i bir daha secmiyordu; `image_url`
degisince vektor eski gorselde kaliyordu.
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

DOMAIN = "test-gorsel-degisimi.example"


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
                   VALUES ('test-gorsel-degisimi', 'Test', %s, 'shopify') RETURNING id""",
                (DOMAIN,),
            )
            row = cur.fetchone()
        owner.commit()
        assert row is not None
        yield int(row[0])
        with owner.cursor() as cur:
            _cleanup(cur)
        owner.commit()


def test_changed_image_drops_stale_vector_and_hash(merchant_id: int) -> None:
    offer = NormalizedOffer(
        external_id="u1",
        url=f"https://{DOMAIN}/u1",
        title_raw="Test Urun",
        current_price=100000,
        list_price=None,
        in_stock=True,
        image_url="https://cdn.example/a.jpg",
        currency="TRY",
    )
    with _owner() as conn:
        first = OfferWriter(conn, merchant_id=merchant_id, observed_at=datetime.now(UTC))
        offer_id = first.write(offer)
        conn.execute("UPDATE offer SET image_hash = 'eski' WHERE id = %s", (offer_id,))
        conn.execute(
            """INSERT INTO embedding (target_type, target_id, kind, model_version, vector)
               VALUES ('offer', %s, 'image', 'test', %s)""",
            (offer_id, to_literal([1.0] + [0.0] * 767)),
        )
        conn.commit()

        # Ayni gorselle ikinci yazim: hicbir sey silinmez.
        same = OfferWriter(conn, merchant_id=merchant_id, observed_at=datetime.now(UTC))
        same.write(offer)
        conn.commit()
        assert same.counts.stale_image_embeddings == 0

        changed = OfferWriter(conn, merchant_id=merchant_id, observed_at=datetime.now(UTC))
        changed.write(replace(offer, image_url="https://cdn.example/b.jpg"))
        conn.commit()

        row = conn.execute(
            """SELECT o.image_hash,
                      (SELECT count(*) FROM embedding e
                        WHERE e.target_type = 'offer' AND e.target_id = o.id AND e.kind = 'image')
                 FROM offer o WHERE o.id = %s""",
            (offer_id,),
        ).fetchone()

    assert changed.counts.stale_image_embeddings == 1
    assert row == (None, 0)
