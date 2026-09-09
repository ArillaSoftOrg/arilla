"""B5 entegrasyon testleri.

Bu testler kenarlarin SAYISINI degil YAPISINI dogrular: cift yonluluk,
kalite tabani, idempotentlik. Sayilar sahte embedding istemcisiyle uretilen
bir artefakt olurdu — vektorler anlamsal degil (bkz. docs/decisions/0016).
Yapisal ozellikler ise vektor kalitesinden bagimsiz olarak dogru olmali.
"""

from __future__ import annotations

from collections.abc import Iterator

import psycopg
import pytest

from db.connection import database_url
from similarity.edges import MIN_SCORE, build_edges
from similarity.pipeline import refresh_price_stats
from similarity.vectors import to_literal

pytestmark = pytest.mark.integration

DOMAIN = "test-b5-magaza.example"
MODEL = "test-b5-model"

# psycopg `%` isaretini placeholder sanar; LIKE deseninde `%%` ile kacirilir.
CLEANUP = (
    """DELETE FROM similarity_edge WHERE product_a IN (
        SELECT id FROM product WHERE slug LIKE 'b5-test-%%')
        OR product_b IN (SELECT id FROM product WHERE slug LIKE 'b5-test-%%')""",
    """DELETE FROM product_price_stats WHERE product_id IN (
        SELECT id FROM product WHERE slug LIKE 'b5-test-%%')""",
    """DELETE FROM embedding WHERE target_type = 'offer' AND target_id IN (
        SELECT o.id FROM offer o JOIN merchant m ON m.id = o.merchant_id
         WHERE m.domain = %(domain)s)""",
    """DELETE FROM price_point WHERE offer_id IN (
        SELECT o.id FROM offer o JOIN merchant m ON m.id = o.merchant_id
         WHERE m.domain = %(domain)s)""",
    "DELETE FROM offer WHERE merchant_id IN (SELECT id FROM merchant WHERE domain = %(domain)s)",
    "DELETE FROM merchant WHERE domain = %(domain)s",
    "DELETE FROM product WHERE slug LIKE 'b5-test-%%'",
)


def _owner() -> psycopg.Connection:
    return psycopg.connect(database_url("DATABASE_URL_OWNER"))


def _unit_vector(index: int, width: int = 768) -> list[float]:
    """Eksen vektoru: ayni index birebir ayni, farkli index dik."""
    vector = [0.0] * width
    vector[index % width] = 1.0
    return vector


@pytest.fixture
def catalogue() -> Iterator[list[int]]:
    """Uc urun: ikisi ayni gorsel vektoru, ucuncu dik."""
    try:
        owner = _owner()
    except psycopg.OperationalError as error:  # pragma: no cover
        pytest.skip(f"yerel veritabani yok: {error}")

    with owner:
        with owner.cursor() as cur:
            for statement in CLEANUP:
                cur.execute(statement, {"domain": DOMAIN})
            cur.execute(
                """INSERT INTO merchant (slug, name, domain, source_type)
                   VALUES ('test-b5', 'Test B5', %s, 'xml_feed') RETURNING id""",
                (DOMAIN,),
            )
            merchant_row = cur.fetchone()
            assert merchant_row is not None
            merchant_id = int(merchant_row[0])

            product_ids: list[int] = []
            # Urun 0 ve 1 ayni vektoru paylasir (benzer), 2 diktir (benzemez).
            for index, axis in enumerate((3, 3, 90)):
                cur.execute(
                    """INSERT INTO product (slug, title) VALUES (%s, %s) RETURNING id""",
                    (f"b5-test-{index}", f"B5 Test Urun {index}"),
                )
                product_row = cur.fetchone()
                assert product_row is not None
                product_id = int(product_row[0])
                product_ids.append(product_id)

                cur.execute(
                    """INSERT INTO offer
                        (merchant_id, product_id, external_id, url, title_raw,
                         current_price, in_stock)
                       VALUES (%s, %s, %s, %s, %s, %s, TRUE) RETURNING id""",
                    (
                        merchant_id,
                        product_id,
                        f"b5-{index}",
                        f"https://{DOMAIN}/u/{index}",
                        f"B5 Test Urun {index}",
                        10000 + index,
                    ),
                )
                offer_row = cur.fetchone()
                assert offer_row is not None
                offer_id = int(offer_row[0])

                cur.execute(
                    """INSERT INTO embedding
                        (target_type, target_id, kind, model_version, vector)
                       VALUES ('offer', %s, 'image', %s, %s)""",
                    (offer_id, MODEL, to_literal(_unit_vector(axis))),
                )
                cur.execute(
                    """INSERT INTO price_point (offer_id, observed_at, price, list_price, in_stock)
                       VALUES (%s, now() - interval '2 days', %s, %s, TRUE),
                              (%s, now() - interval '1 day',  %s, %s, TRUE)""",
                    (
                        offer_id,
                        12000 + index,
                        13000 + index,
                        offer_id,
                        10000 + index,
                        13000 + index,
                    ),
                )
        owner.commit()

        yield product_ids

        with owner.cursor() as cur:
            for statement in CLEANUP:
                cur.execute(statement, {"domain": DOMAIN})
        owner.commit()


def _edges(product_id: int) -> list[tuple[int, int, float]]:
    with _owner() as conn, conn.cursor() as cur:
        cur.execute(
            """SELECT product_a, product_b, score FROM similarity_edge
                WHERE kind = 'visual' AND (product_a = %s OR product_b = %s)""",
            (product_id, product_id),
        )
        return [(int(a), int(b), float(s)) for a, b, s in cur.fetchall()]


def test_edges_are_written_in_both_directions(catalogue: list[int]) -> None:
    """`similarity_lookup_idx` sorguyu `product_a` uzerinden yapiyor.

    Tek yon yazilirsa alternatifler yalnizca bir taraftan gorunur.
    """
    first, second, _third = catalogue
    with _owner() as conn:
        build_edges(conn, "visual")
        conn.commit()

    pairs = {(a, b) for a, b, _ in _edges(first)}
    assert (first, second) in pairs
    assert (second, first) in pairs


def test_dissimilar_products_stay_below_the_floor(catalogue: list[int]) -> None:
    """Dik vektorlu urun kenar ALMAMALI — kalite tabani bunun icin var."""
    first, _second, third = catalogue
    with _owner() as conn:
        build_edges(conn, "visual")
        conn.commit()

    partners = {b for a, b, _ in _edges(first) if a == first}
    assert third not in partners

    for _a, _b, score in _edges(first):
        assert score >= MIN_SCORE["visual"]


def test_rerunning_does_not_duplicate_edges(catalogue: list[int]) -> None:
    first, _second, _third = catalogue
    with _owner() as conn:
        build_edges(conn, "visual")
        conn.commit()
    before = len(_edges(first))

    with _owner() as conn:
        build_edges(conn, "visual")
        conn.commit()

    assert len(_edges(first)) == before


def test_price_stats_are_populated_for_every_product(catalogue: list[int]) -> None:
    with _owner() as conn:
        refresh_price_stats(conn)
        conn.commit()

    with _owner() as conn, conn.cursor() as cur:
        cur.execute(
            """SELECT product_id, min_90d, max_90d, median_90d, current_percentile,
                      drop_count_90d
                 FROM product_price_stats WHERE product_id = ANY(%s)""",
            (catalogue,),
        )
        rows = cur.fetchall()

    assert len(rows) == len(catalogue)
    for _pid, min_90d, max_90d, median, percentile, drops in rows:
        assert min_90d is not None and max_90d is not None
        assert median is not None
        assert percentile is not None
        # Her teklifte fiyat bir kez dustu.
        assert drops == 1
