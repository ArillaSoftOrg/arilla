"""Gorsel aday kanali: gercek vektor yakinligi (AI denetimi A3).

Eski sorgu `SELECT DISTINCT ON (p.id) ... ORDER BY p.id, e.vector <=> :v LIMIT 30`
en yakin 30 urunu degil EN KUCUK 30 `id`'yi donduruyordu: `DISTINCT ON` ilk
siralama anahtari olarak `p.id` istiyor, mesafe yalnizca ayni urunun teklifleri
arasinda secim yapiyordu. En yakin urun yuksek `id`'liyse hic aday olmuyordu.
"""

from __future__ import annotations

from collections.abc import Iterator

import psycopg
import pytest

from db.connection import database_url
from resolve import candidates
from similarity.vectors import to_literal

pytestmark = pytest.mark.integration

DOMAIN = "test-aihard-img.example"
MODEL = "test-aihard-model"
SLUG = "aihard-img-"

CLEANUP = (
    """DELETE FROM embedding WHERE target_type = 'offer' AND target_id IN (
        SELECT o.id FROM offer o JOIN merchant m ON m.id = o.merchant_id
         WHERE m.domain = %(domain)s)""",
    "DELETE FROM offer WHERE merchant_id IN (SELECT id FROM merchant WHERE domain = %(domain)s)",
    "DELETE FROM merchant WHERE domain = %(domain)s",
    "DELETE FROM product WHERE slug LIKE 'aihard-img-%%'",
)


def _axis(index: int, width: int = 768) -> list[float]:
    vector = [0.0] * width
    vector[index % width] = 1.0
    return vector


def _near(index: int, other: int, weight: float = 0.3) -> list[float]:
    """index eksenine yakin, other eksenine biraz kayik (normalize degil; kosinus onemli)."""
    vector = _axis(index)
    vector[other % 768] = weight
    return vector


@pytest.fixture
def conn() -> Iterator[psycopg.Connection]:
    try:
        connection = psycopg.connect(database_url("DATABASE_URL_OWNER"))
    except psycopg.OperationalError as error:  # pragma: no cover
        pytest.skip(f"yerel veritabani yok: {error}")
    with connection:
        with connection.cursor() as cur:
            for statement in CLEANUP:
                cur.execute(statement, {"domain": DOMAIN})
        connection.commit()
        yield connection
        connection.rollback()
        with connection.cursor() as cur:
            for statement in CLEANUP:
                cur.execute(statement, {"domain": DOMAIN})
        connection.commit()


def _seed(conn: psycopg.Connection, vectors: list[list[float]]) -> tuple[list[int], list[int]]:
    """Her vektor icin bir urun + bir teklif + bir gorsel embedding. (product_ids, offer_ids)"""
    with conn.cursor() as cur:
        cur.execute(
            """INSERT INTO merchant (slug, name, domain, source_type)
               VALUES ('test-aihard-img', 'Test AIHard Img', %s, 'xml_feed') RETURNING id""",
            (DOMAIN,),
        )
        merchant_id = int(cur.fetchone()[0])
        product_ids: list[int] = []
        offer_ids: list[int] = []
        for index, vector in enumerate(vectors):
            cur.execute(
                "INSERT INTO product (slug, title) VALUES (%s, %s) RETURNING id",
                (f"{SLUG}{index:03d}", f"Aday Urun {index}"),
            )
            product_id = int(cur.fetchone()[0])
            cur.execute(
                """INSERT INTO offer (merchant_id, product_id, external_id, url, title_raw,
                                      current_price, in_stock)
                   VALUES (%s, %s, %s, %s, %s, 10000, TRUE) RETURNING id""",
                (merchant_id, product_id, f"ai-{index}", f"https://{DOMAIN}/{index}", f"U {index}"),
            )
            offer_id = int(cur.fetchone()[0])
            cur.execute(
                """INSERT INTO embedding (target_type, target_id, kind, model_version, vector)
                   VALUES ('offer', %s, 'image', %s, %s)""",
                (offer_id, MODEL, to_literal(vector)),
            )
            product_ids.append(product_id)
            offer_ids.append(offer_id)
    conn.commit()
    return product_ids, offer_ids


def test_nearest_product_is_returned_even_with_a_high_id(conn: psycopg.Connection) -> None:
    # 44 dik ("uzak") urun, en son (en yuksek id) sorguyla BIREBIR ayni vektorlu urun.
    vectors = [_axis(100 + i) for i in range(44)] + [_axis(7)]
    product_ids, _ = _seed(conn, vectors)
    nearest = product_ids[-1]

    found = candidates.by_image(conn, offer_id=-1, vector=to_literal(_axis(7)), model_version=MODEL)

    assert found, "aday donmedi"
    assert found[0].product_id == nearest
    assert len(found) <= candidates.PER_CHANNEL_LIMIT


def test_candidates_are_ordered_by_distance(conn: psycopg.Connection) -> None:
    vectors = [_axis(200 + i) for i in range(5)] + [_near(7, 300), _axis(7), _near(7, 301, 1.0)]
    product_ids, _ = _seed(conn, vectors)
    exact, slightly_off, further_off = product_ids[6], product_ids[5], product_ids[7]

    found = candidates.by_image(conn, offer_id=-1, vector=to_literal(_axis(7)), model_version=MODEL)

    order = [candidate.product_id for candidate in found]
    assert order[:3] == [exact, slightly_off, further_off]


def test_a_product_with_several_offers_appears_once(conn: psycopg.Connection) -> None:
    product_ids, offer_ids = _seed(conn, [_axis(7), _axis(50)])
    with conn.cursor() as cur:
        cur.execute(
            """INSERT INTO offer (merchant_id, product_id, external_id, url, title_raw,
                                  current_price, in_stock)
               SELECT merchant_id, product_id, 'ai-second', 'https://' || %s || '/second', 'U2',
                      10000, TRUE FROM offer WHERE id = %s RETURNING id""",
            (DOMAIN, offer_ids[0]),
        )
        second_offer = int(cur.fetchone()[0])
        cur.execute(
            """INSERT INTO embedding (target_type, target_id, kind, model_version, vector)
               VALUES ('offer', %s, 'image', %s, %s)""",
            (second_offer, MODEL, to_literal(_near(7, 8))),
        )
    conn.commit()

    found = candidates.by_image(conn, offer_id=-1, vector=to_literal(_axis(7)), model_version=MODEL)

    ids = [candidate.product_id for candidate in found]
    assert ids.count(product_ids[0]) == 1
    assert ids[0] == product_ids[0]


def test_the_offer_itself_is_excluded(conn: psycopg.Connection) -> None:
    product_ids, offer_ids = _seed(conn, [_axis(7), _axis(8)])

    found = candidates.by_image(
        conn, offer_id=offer_ids[0], vector=to_literal(_axis(7)), model_version=MODEL
    )

    assert product_ids[0] not in [candidate.product_id for candidate in found]
