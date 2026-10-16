"""Set tabanli benzerlik/fiyat isinin (Faz 3) dogruluk sozlesmesi.

- Kenarlar eski Python algoritmasiyla (urun vektoru = normalize ortalama,
  skor = urun vektorleri kosinusu, urun basina en iyi TOP_N, taban) ayni.
- Sonuc parti buyuklugunden ve ara commit'ten bagimsiz.
- Model surumleri karismaz; `prune` yalnizca istenince ve tam kosuda siler.
- Fiyat istatistikleri partiden bagimsiz; TRY disi gecmis dagilima girmez.
"""

from __future__ import annotations

import random
from collections.abc import Iterator
from datetime import timedelta

import psycopg
import pytest

from db import product_aggregates
from db.connection import database_url
from similarity import edges as edges_module
from similarity.edges import ANN_FETCH, MIN_SCORE, TOP_N, build_edges
from similarity.pipeline import refresh_price_stats
from similarity.vectors import average, cosine, to_literal

pytestmark = pytest.mark.integration

DOMAIN = "test-sbatch.example"
SLUG = "sbatch-test-"
MODEL = "test-sbatch-model"
OTHER_MODEL = "test-sbatch-model-b"
WIDTH = 768
PRODUCTS = 24

CLEANUP = (
    f"""DELETE FROM similarity_edge WHERE product_a IN (
        SELECT id FROM product WHERE slug LIKE '{SLUG}%%')
        OR product_b IN (SELECT id FROM product WHERE slug LIKE '{SLUG}%%')""",
    f"""DELETE FROM product_price_stats WHERE product_id IN (
        SELECT id FROM product WHERE slug LIKE '{SLUG}%%')""",
    """DELETE FROM embedding WHERE target_type = 'offer' AND target_id IN (
        SELECT o.id FROM offer o JOIN merchant m ON m.id = o.merchant_id
         WHERE m.domain = %(domain)s)""",
    """DELETE FROM price_point WHERE offer_id IN (
        SELECT o.id FROM offer o JOIN merchant m ON m.id = o.merchant_id
         WHERE m.domain = %(domain)s)""",
    "DELETE FROM offer WHERE merchant_id IN (SELECT id FROM merchant WHERE domain = %(domain)s)",
    "DELETE FROM merchant WHERE domain = %(domain)s",
    f"DELETE FROM product WHERE slug LIKE '{SLUG}%%'",
)


@pytest.fixture(autouse=True)
def _history_gate_open(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("similarity.prices.MIN_PERCENTILE_OBSERVATIONS", 1)
    monkeypatch.setattr("similarity.prices.MIN_PERCENTILE_DISTINCT_PRICES", 1)
    monkeypatch.setattr("similarity.prices.MIN_PERCENTILE_SPAN", timedelta(0))


def _owner() -> psycopg.Connection:
    return psycopg.connect(database_url("DATABASE_URL_OWNER"))


def _clustered_vector(rng: random.Random, cluster: int) -> list[float]:
    """Kume merkezi + gurultu: ayni kumedekiler benzer (taban ustu), digerleri degil."""
    vector = [rng.gauss(0.0, 0.02) for _ in range(WIDTH)]
    vector[cluster * 7] += 1.0
    vector[cluster * 7 + 1] += 0.6
    return vector


@pytest.fixture
def catalogue() -> Iterator[dict[str, object]]:
    """24 urun, 4 kume; her urunun 1-3 teklifi ve teklif basina kendi vektoru."""
    try:
        owner = _owner()
    except psycopg.OperationalError as error:  # pragma: no cover
        pytest.skip(f"yerel veritabani yok: {error}")

    rng = random.Random(20261017)
    vectors: dict[int, list[list[float]]] = {}
    with owner:
        with owner.cursor() as cur:
            for statement in CLEANUP:
                cur.execute(statement, {"domain": DOMAIN})
            cur.execute(
                """INSERT INTO merchant (slug, name, domain, source_type)
                   VALUES ('test-sbatch', 'Test SBatch', %s, 'xml_feed') RETURNING id""",
                (DOMAIN,),
            )
            merchant_id = int(cur.fetchone()[0])  # type: ignore[index]
            product_ids: list[int] = []
            for index in range(PRODUCTS):
                cur.execute(
                    "INSERT INTO product (slug, title) VALUES (%s, %s) RETURNING id",
                    (f"{SLUG}{index}", f"SBatch {index}"),
                )
                product_id = int(cur.fetchone()[0])  # type: ignore[index]
                product_ids.append(product_id)
                for offer_index in range(1 + index % 3):
                    cur.execute(
                        """INSERT INTO offer (merchant_id, product_id, external_id, url, title_raw,
                                              current_price, in_stock)
                           VALUES (%s, %s, %s, %s, %s, %s, TRUE) RETURNING id""",
                        (
                            merchant_id,
                            product_id,
                            f"sb-{index}-{offer_index}",
                            f"https://{DOMAIN}/u/{index}/{offer_index}",
                            f"SBatch {index}/{offer_index}",
                            10_000 + index,
                        ),
                    )
                    offer_id = int(cur.fetchone()[0])  # type: ignore[index]
                    vector = _clustered_vector(rng, index % 4)
                    vectors.setdefault(product_id, []).append(vector)
                    cur.execute(
                        """INSERT INTO embedding
                               (target_type, target_id, kind, model_version, vector)
                           VALUES ('offer', %s, 'image', %s, %s)""",
                        (offer_id, MODEL, to_literal(vector)),
                    )
                    for days_ago, price in ((6, 12_000 + index), (3, 11_000), (1, 10_000 + index)):
                        cur.execute(
                            """INSERT INTO price_point (offer_id, observed_at, price, list_price,
                                                       in_stock)
                               VALUES (%s, now() - make_interval(days => %s), %s, NULL, TRUE)""",
                            (offer_id, days_ago, price),
                        )
            cur.execute("SELECT id FROM offer WHERE merchant_id = %s ORDER BY id", (merchant_id,))
            offer_ids = [int(row[0]) for row in cur.fetchall()]
        owner.commit()

        yield {
            "merchant_id": merchant_id,
            "product_ids": product_ids,
            "offer_ids": offer_ids,
            "vectors": vectors,
        }

        with owner.cursor() as cur:
            for statement in CLEANUP:
                cur.execute(statement, {"domain": DOMAIN})
        owner.commit()


def _reference_edges(vectors: dict[int, list[list[float]]]) -> dict[tuple[int, int], float]:
    """Eski `build_edges`'in Python hesabi, tam (ANN yerine kaba kuvvet) komsulukla.

    Fixture kucuk (ANN_FETCH'ten az teklif): ANN tum teklifleri dondurur, kaba kuvvet
    ayni aday kumesidir.
    """
    assert sum(len(group) for group in vectors.values()) <= ANN_FETCH
    product_vectors = {pid: average(group) for pid, group in vectors.items()}
    expected: dict[tuple[int, int], float] = {}
    for pid, own in product_vectors.items():
        assert own is not None
        scored = {
            other: cosine(own, vector)
            for other, vector in product_vectors.items()
            if other != pid and vector is not None
        }
        ranked = sorted(((o, s) for o, s in scored.items() if s > 0), key=lambda i: -i[1])[:TOP_N]
        for other, score in ranked:
            if score >= MIN_SCORE["visual"]:
                expected[(pid, other)] = round(score, 4)
                expected[(other, pid)] = round(score, 4)
    return expected


def _edges(product_ids: list[int]) -> dict[tuple[int, int], float]:
    with _owner() as conn, conn.cursor() as cur:
        cur.execute(
            """SELECT product_a, product_b, score FROM similarity_edge
                WHERE kind = 'visual' AND product_a = ANY(%s)""",
            (product_ids,),
        )
        return {(int(a), int(b)): float(s) for a, b, s in cur.fetchall()}


def _clear_edges(product_ids: list[int]) -> None:
    with _owner() as conn, conn.cursor() as cur:
        cur.execute(
            "DELETE FROM similarity_edge WHERE product_a = ANY(%s) OR product_b = ANY(%s)",
            (product_ids, product_ids),
        )


def test_edges_match_the_python_reference(catalogue: dict[str, object]) -> None:
    product_ids: list[int] = catalogue["product_ids"]  # type: ignore[assignment]
    expected = _reference_edges(catalogue["vectors"])  # type: ignore[arg-type]
    assert expected, "fixture taban ustu kenar uretmeli"

    with _owner() as conn:
        build_edges(conn, "visual")
        conn.commit()
    actual = _edges(product_ids)

    assert set(actual) == set(expected)
    for key, score in expected.items():
        # Veritabani vektorleri float4; Python float8. Dort basamakta yuvarlanmis skor.
        assert actual[key] == pytest.approx(score, abs=2e-4), key


def test_result_does_not_depend_on_batch_size_or_commit(catalogue: dict[str, object]) -> None:
    product_ids: list[int] = catalogue["product_ids"]  # type: ignore[assignment]
    with _owner() as conn:
        build_edges(conn, "visual", batch_size=500)
        conn.commit()
    single = _edges(product_ids)

    _clear_edges(product_ids)
    with _owner() as conn:
        build_edges(conn, "visual", batch_size=1, commit=True)
        conn.commit()
    assert _edges(product_ids) == single


def test_model_versions_are_not_mixed(catalogue: dict[str, object]) -> None:
    """Ikinci modelin vektoru ilk modelin vektorleriyle ortalanmaz ve karsilastirilmaz."""
    product_ids: list[int] = catalogue["product_ids"]  # type: ignore[assignment]
    offer_ids: list[int] = catalogue["offer_ids"]  # type: ignore[assignment]
    with _owner() as conn:
        build_edges(conn, "visual")
        conn.commit()
    before = _edges(product_ids)

    # Ilk teklife ikinci modelde, her seye dik bir vektor eklenir.
    odd = [0.0] * WIDTH
    odd[WIDTH - 1] = 1.0
    with _owner() as conn, conn.cursor() as cur:
        cur.execute(
            """INSERT INTO embedding (target_type, target_id, kind, model_version, vector)
               VALUES ('offer', %s, 'image', %s, %s)""",
            (offer_ids[0], OTHER_MODEL, to_literal(odd)),
        )
    _clear_edges(product_ids)
    with _owner() as conn:
        build_edges(conn, "visual")
        conn.commit()
    # Tek uyeli ikinci model grubu kenar uretmez; ilk modelin kenarlari degismez.
    assert _edges(product_ids) == before


def test_prune_only_when_asked_and_only_on_full_runs(catalogue: dict[str, object]) -> None:
    product_ids: list[int] = catalogue["product_ids"]  # type: ignore[assignment]
    a, b = product_ids[0], product_ids[1]  # farkli kumeler: gercek kenar degil
    with _owner() as conn, conn.cursor() as cur:
        cur.execute(
            """INSERT INTO similarity_edge (product_a, product_b, kind, score)
               VALUES (%s, %s, 'visual', 0.99) ON CONFLICT DO NOTHING""",
            (a, b),
        )

    def stale_present() -> bool:
        return (a, b) in _edges([a])

    with _owner() as conn:
        build_edges(conn, "visual")
        conn.commit()
    assert stale_present(), "varsayilan kosu veri silmez"

    with _owner() as conn:
        build_edges(conn, "visual", limit=3, prune=True)
        conn.commit()
    assert stale_present(), "kismi kosu prune yapmaz"

    with _owner() as conn:
        counts = build_edges(conn, "visual", prune=True)
        conn.commit()
    assert not stale_present()
    assert counts.edges_pruned >= 1
    assert _edges(product_ids), "gecerli kenarlar kalir"


def test_concurrent_runs_are_refused(catalogue: dict[str, object]) -> None:
    with _owner() as holder, holder.cursor() as cur:
        cur.execute("SELECT pg_advisory_lock(%s)", (edges_module.EDGE_LOCK_KEY,))
        with _owner() as conn, pytest.raises(RuntimeError, match="baska bir similarity"):
            build_edges(conn, "visual")
        cur.execute("SELECT pg_advisory_unlock(%s)", (edges_module.EDGE_LOCK_KEY,))


def _stats(product_ids: list[int]) -> dict[int, tuple[object, ...]]:
    with _owner() as conn, conn.cursor() as cur:
        cur.execute(
            """SELECT product_id, min_30d, min_90d, max_90d, median_90d, current_percentile,
                      drop_count_90d, last_drop_at, list_price_inflated
                 FROM product_price_stats WHERE product_id = ANY(%s)""",
            (product_ids,),
        )
        return {int(row[0]): tuple(row[1:]) for row in cur.fetchall()}


def test_price_stats_do_not_depend_on_batch_size(catalogue: dict[str, object]) -> None:
    product_ids: list[int] = catalogue["product_ids"]  # type: ignore[assignment]
    with _owner() as conn:
        refresh_price_stats(conn, batch_size=1000)
        conn.commit()
    big = _stats(product_ids)
    assert len(big) == len(product_ids)

    with _owner() as conn, conn.cursor() as cur:
        cur.execute("DELETE FROM product_price_stats WHERE product_id = ANY(%s)", (product_ids,))
    with _owner() as conn:
        refresh_price_stats(conn, batch_size=3, commit=True)
        conn.commit()
    assert _stats(product_ids) == big


def test_foreign_currency_history_is_excluded(catalogue: dict[str, object]) -> None:
    product_ids: list[int] = catalogue["product_ids"]  # type: ignore[assignment]
    offer_ids: list[int] = catalogue["offer_ids"]  # type: ignore[assignment]
    # Urun 0'in tek teklifi yurt disina doner: fiyat noktalari USD cent'tir.
    with _owner() as conn, conn.cursor() as cur:
        cur.execute("UPDATE offer SET currency = 'USD' WHERE id = %s", (offer_ids[0],))
    with _owner() as conn:
        refresh_price_stats(conn)
        conn.commit()
    stats = _stats(product_ids)
    assert product_ids[0] not in stats
    assert product_ids[1] in stats


def test_batched_aggregate_refresh_matches_single_statement(
    catalogue: dict[str, object],
) -> None:
    product_ids: list[int] = catalogue["product_ids"]  # type: ignore[assignment]

    def snapshot() -> list[tuple[object, ...]]:
        with _owner() as conn, conn.cursor() as cur:
            cur.execute(
                """SELECT id, min_price, max_price, offer_count, in_stock_count
                     FROM product WHERE id = ANY(%s) ORDER BY id""",
                (product_ids,),
            )
            return list(cur.fetchall())

    with _owner() as conn, conn.cursor() as cur:
        cur.execute(
            "UPDATE product SET min_price = NULL, offer_count = 0 WHERE id = ANY(%s)",
            (product_ids,),
        )
    with _owner() as conn:
        product_aggregates.refresh_all(conn)
        conn.commit()
    expected = snapshot()

    with _owner() as conn, conn.cursor() as cur:
        cur.execute(
            "UPDATE product SET min_price = NULL, offer_count = 0 WHERE id = ANY(%s)",
            (product_ids,),
        )
    with _owner() as conn:
        product_aggregates.refresh_all_batched(conn, batch_size=5, commit=True)
        conn.commit()
    assert snapshot() == expected
    with _owner() as conn:
        assert product_aggregates.refresh_all_batched(conn, batch_size=5) == 0
