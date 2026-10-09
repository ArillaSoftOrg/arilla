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


def test_product_aggregates_follow_active_offers(catalogue: list[int]) -> None:
    with _owner() as conn:
        refresh_price_stats(conn)
        conn.commit()
        # Ilk urunun tek teklifi pasiflesir: ozet sifirlanmali.
        with conn.cursor() as cur:
            cur.execute("UPDATE offer SET is_active = FALSE WHERE product_id = %s", (catalogue[0],))
        refresh_price_stats(conn)
        conn.commit()

    with _owner() as conn, conn.cursor() as cur:
        cur.execute(
            """SELECT id, min_price, max_price, offer_count, in_stock_count
                 FROM product WHERE id = ANY(%s) ORDER BY id""",
            (catalogue,),
        )
        rows = {row[0]: row[1:] for row in cur.fetchall()}

    assert rows[catalogue[0]] == (None, None, 0, 0)
    assert rows[catalogue[1]] == (10001, 10001, 1, 1)
    assert rows[catalogue[2]] == (10002, 10002, 1, 1)


# --- fiyat istatistikleri: yalnizca aktif magaza ------------------------------

PS_SLUG = "b5ps-test-"
PS_DOMAINS = ("test-b5ps-a.example", "test-b5ps-b.example", "test-b5ps-c.example")

PS_CLEANUP = (
    "DELETE FROM product_price_stats WHERE product_id IN ("
    "  SELECT id FROM product WHERE slug LIKE 'b5ps-test-%%')",
    """DELETE FROM price_point WHERE offer_id IN (
        SELECT o.id FROM offer o JOIN merchant m ON m.id = o.merchant_id
         WHERE m.domain = ANY(%(domains)s))""",
    """DELETE FROM offer WHERE merchant_id IN (
        SELECT id FROM merchant WHERE domain = ANY(%(domains)s))""",
    "DELETE FROM merchant WHERE domain = ANY(%(domains)s)",
    "DELETE FROM product WHERE slug LIKE 'b5ps-test-%%'",
)


def _ps_merchant(cur: psycopg.Cursor, key: str, domain: str, active: bool) -> int:
    cur.execute(
        """INSERT INTO merchant (slug, name, domain, source_type, is_active)
           VALUES (%s, %s, %s, 'xml_feed', %s) RETURNING id""",
        (f"test-b5ps-{key}", f"Test B5PS {key}", domain, active),
    )
    row = cur.fetchone()
    assert row is not None
    return int(row[0])


def _ps_offer(
    cur: psycopg.Cursor,
    merchant_id: int,
    product_id: int,
    key: str,
    current_price: int | None,
    history: list[tuple[int, int]],
    active: bool = True,
) -> None:
    """`history`: (kac gun once, fiyat) ciftleri."""
    cur.execute(
        """INSERT INTO offer
            (merchant_id, product_id, external_id, url, title_raw, current_price,
             in_stock, is_active)
           VALUES (%s, %s, %s, %s, %s, %s, TRUE, %s) RETURNING id""",
        (
            merchant_id,
            product_id,
            f"b5ps-{key}",
            f"https://{PS_DOMAINS[0]}/u/{key}",
            f"B5PS {key}",
            current_price,
            active,
        ),
    )
    row = cur.fetchone()
    assert row is not None
    for days_ago, price in history:
        cur.execute(
            """INSERT INTO price_point (offer_id, observed_at, price, list_price, in_stock)
               VALUES (%s, now() - make_interval(days => %s), %s, NULL, TRUE)""",
            (int(row[0]), days_ago, price),
        )


@pytest.fixture
def merchant_catalogue() -> Iterator[dict[str, int]]:
    """A aktif, B pasif, C aktif (testte pasiflestirilir) magaza ve senaryo urunleri."""
    try:
        owner = _owner()
    except psycopg.OperationalError as error:  # pragma: no cover
        pytest.skip(f"yerel veritabani yok: {error}")

    with owner:
        with owner.cursor() as cur:
            for statement in PS_CLEANUP:
                cur.execute(statement, {"domains": list(PS_DOMAINS)})
            a = _ps_merchant(cur, "a", PS_DOMAINS[0], True)
            b = _ps_merchant(cur, "b", PS_DOMAINS[1], False)
            c = _ps_merchant(cur, "c", PS_DOMAINS[2], True)

            ids: dict[str, int] = {"merchant_c": c}
            for name in (
                "mixed",
                "inactive_offer",
                "only_inactive",
                "stale",
                "no_current",
                "toggle",
            ):
                cur.execute(
                    "INSERT INTO product (slug, title) VALUES (%s, %s) RETURNING id",
                    (f"{PS_SLUG}{name}", f"B5PS {name}"),
                )
                row = cur.fetchone()
                assert row is not None
                ids[name] = int(row[0])

            # Aktif magaza 3000; pasif magazanin AKTIF teklifi daha ucuz (2000).
            _ps_offer(cur, a, ids["mixed"], "mixed-a", 3000, [(5, 2500), (3, 3500), (1, 3000)])
            _ps_offer(cur, b, ids["mixed"], "mixed-b", 2000, [(2, 2000)])
            # Aktif magazanin pasif teklifi: gecmisi kalir, guncel fiyata girmez.
            _ps_offer(cur, a, ids["inactive_offer"], "io-a1", 5000, [(1, 5000)])
            _ps_offer(cur, a, ids["inactive_offer"], "io-a2", 4000, [(4, 4000)], active=False)
            # Yalnizca pasif magaza.
            _ps_offer(cur, b, ids["only_inactive"], "oi-b", 1000, [(1, 1000)])
            # Aktif magaza gecmisi var ama kullanilabilir guncel fiyat yok.
            _ps_offer(cur, a, ids["no_current"], "nc-a", 700, [(2, 700)], active=False)
            # C magazasi testte pasiflesecek.
            _ps_offer(cur, a, ids["toggle"], "tg-a", 800, [(3, 700), (2, 900), (1, 800)])
            _ps_offer(cur, c, ids["toggle"], "tg-c", 600, [(1, 600)])

            # Eski kosulardan kalmis satirlar: hesaplanmayacak urunlerde silinmeli.
            for name in ("only_inactive", "stale"):
                cur.execute(
                    """INSERT INTO product_price_stats
                        (product_id, min_90d, max_90d, median_90d, current_percentile)
                       VALUES (%s, 1, 1, 1, 0)""",
                    (ids[name],),
                )
        owner.commit()

        yield ids

        with owner.cursor() as cur:
            for statement in PS_CLEANUP:
                cur.execute(statement, {"domains": list(PS_DOMAINS)})
        owner.commit()


def _stats(product_ids: list[int]) -> dict[int, tuple[object, ...]]:
    with _owner() as conn, conn.cursor() as cur:
        cur.execute(
            """SELECT product_id, min_30d, min_90d, max_90d, median_90d, current_percentile,
                      drop_count_90d, last_drop_at, list_price_inflated, list_price_raised_at
                 FROM product_price_stats WHERE product_id = ANY(%s)""",
            (product_ids,),
        )
        return {int(row[0]): tuple(row[1:]) for row in cur.fetchall()}


def _refresh() -> None:
    with _owner() as conn:
        refresh_price_stats(conn)
        conn.commit()


def _percentile_and_min(ids: dict[str, int], name: str) -> tuple[object, object]:
    row = _stats([ids[name]])[ids[name]]
    return row[4], row[1]  # current_percentile, min_90d


def test_inactive_merchant_is_excluded_from_current_price_and_history(
    merchant_catalogue: dict[str, int],
) -> None:
    _refresh()
    # Referans 3000 (aktif magaza), dagilim {2500, 3500, 3000}: 1/3 asagida.
    # Eski davranis: referans 2000 (pasif magaza), yuzdelik 0, min 2000.
    assert _percentile_and_min(merchant_catalogue, "mixed") == (33, 2500)


def test_inactive_offer_history_of_an_active_merchant_is_kept(
    merchant_catalogue: dict[str, int],
) -> None:
    _refresh()
    # Pasif teklifin 4000'i gecmiste kalir (min), guncel fiyat 5000.
    assert _percentile_and_min(merchant_catalogue, "inactive_offer") == (50, 4000)


def test_only_inactive_merchants_and_stale_rows_are_removed(
    merchant_catalogue: dict[str, int],
) -> None:
    _refresh()
    remaining = _stats([merchant_catalogue["only_inactive"], merchant_catalogue["stale"]])
    assert remaining == {}


def test_no_usable_current_price_gives_null_percentile(
    merchant_catalogue: dict[str, int],
) -> None:
    _refresh()
    percentile, min_90d = _percentile_and_min(merchant_catalogue, "no_current")
    assert percentile is None
    assert min_90d == 700


def test_deactivating_a_merchant_changes_stats(merchant_catalogue: dict[str, int]) -> None:
    _refresh()
    assert _percentile_and_min(merchant_catalogue, "toggle") == (0, 600)

    with _owner() as conn, conn.cursor() as cur:
        cur.execute(
            "UPDATE merchant SET is_active = FALSE WHERE id = %s",
            (merchant_catalogue["merchant_c"],),
        )
        conn.commit()
    _refresh()
    # C gidince referans 800, dagilim {700, 900, 800}.
    assert _percentile_and_min(merchant_catalogue, "toggle") == (33, 700)


def test_refresh_twice_is_idempotent(merchant_catalogue: dict[str, int]) -> None:
    ids = [value for key, value in merchant_catalogue.items() if key != "merchant_c"]
    _refresh()
    first = _stats(ids)
    with _owner() as conn:
        counts = refresh_price_stats(conn)
        conn.commit()
    assert _stats(ids) == first
    # Ikinci kosuda test urunlerinden silinecek satir kalmadi.
    assert set(first) == set(_stats(ids))
    assert counts.removed >= 0


def test_current_reference_matches_canonical_active_pricing(
    merchant_catalogue: dict[str, int],
) -> None:
    """Yuzdeligin referansi kartlardaki `product.min_price` ile ayni kuraldir."""
    _refresh()
    ids = [value for key, value in merchant_catalogue.items() if key != "merchant_c"]
    with _owner() as conn, conn.cursor() as cur:
        cur.execute(
            """SELECT pps.product_id, pps.current_percentile, p.min_price,
                      round(100.0 * count(pp.price) FILTER (WHERE pp.price < p.min_price)
                            / NULLIF(count(pp.price), 0))::int
                 FROM product_price_stats pps
                 JOIN product p ON p.id = pps.product_id
                 JOIN offer o ON o.product_id = p.id
                 JOIN merchant m ON m.id = o.merchant_id AND m.is_active
                 JOIN price_point pp ON pp.offer_id = o.id
                                    AND pp.observed_at >= now() - interval '90 days'
                WHERE pps.product_id = ANY(%s)
                GROUP BY pps.product_id, pps.current_percentile, p.min_price""",
            (ids,),
        )
        rows = cur.fetchall()

    assert rows, "test urunlerinin istatistigi olmali"
    for _product_id, percentile, min_price, expected in rows:
        if min_price is None:
            assert percentile is None
        else:
            assert percentile == expected
