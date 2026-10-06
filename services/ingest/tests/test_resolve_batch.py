"""Toplu (chunk'li) eslestirme: referans surumle ayni sonuc, olcek, hata, devam (karar 0066).

Yaklasim: ayni baslangic durumunda once ESKI offer-offer surum (islem geri
alinir), sonra YENI toplu surum calisir; offer -> (urun basligi, slug, renk,
barkod, aday durumu/skoru/yontemi) esleme sonuclari esit olmali. Veri seti
1.500+ offer, iki merchant (capraz eslesme), barkodlu/barkodsuz, ayni
barkodu iki kez listeleyen offer, insan tarafindan reddedilmis cift ve gorsel
vektorleri icerir.
"""

from __future__ import annotations

import json
import random
import time
from collections.abc import Iterator
from dataclasses import dataclass

import psycopg
import pytest

from db.connection import database_url
from resolve import batch
from resolve.pipeline import resolve_offers, resolve_offers_sequential

pytestmark = pytest.mark.integration

DOMAIN_A = "test-rb-a.example"
DOMAIN_B = "test-rb-b.example"
BRANDS = ("Rbtest Alfa", "Rbtest Beta", "Rbtest Gamma")
COLORS = ("Siyah", "Beyaz", "Mavi", "Kirmizi")
KINDS = ("Termos", "Bardak", "Sise", "Kupa")

CLEANUP = (
    "DELETE FROM match_candidate WHERE offer_id IN (SELECT o.id FROM offer o JOIN merchant m "
    "ON m.id = o.merchant_id WHERE m.domain IN (%(a)s, %(b)s))",
    "DELETE FROM embedding WHERE target_type = 'offer' AND target_id IN (SELECT o.id FROM offer o "
    "JOIN merchant m ON m.id = o.merchant_id WHERE m.domain IN (%(a)s, %(b)s))",
    "DELETE FROM offer_variant WHERE offer_id IN (SELECT o.id FROM offer o JOIN merchant m "
    "ON m.id = o.merchant_id WHERE m.domain IN (%(a)s, %(b)s))",
    "DELETE FROM offer WHERE merchant_id IN "
    "(SELECT id FROM merchant WHERE domain IN (%(a)s, %(b)s))",
    "DELETE FROM product WHERE slug LIKE 'rbtest-%%'",
    "DELETE FROM brand WHERE slug LIKE 'rbtest-%%'",
    "DELETE FROM merchant WHERE domain IN (%(a)s, %(b)s)",
)


def _owner() -> psycopg.Connection:
    return psycopg.connect(database_url("DATABASE_URL_OWNER"))


def _app() -> psycopg.Connection:
    return psycopg.connect(database_url("DATABASE_URL"))


@dataclass
class Dataset:
    merchant_a: int
    merchant_b: int
    offers_a: int
    offers_b: int


def _make_offers(cur: psycopg.Cursor, merchant_id: int, prefix: str, items: list[dict]) -> None:
    for number, item in enumerate(items):
        cur.execute(
            """INSERT INTO offer (merchant_id, external_id, url, title_raw, brand_raw, image_url,
                                  attributes_raw, current_price, currency, in_stock, is_active)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, 'TRY', TRUE, TRUE) RETURNING id""",
            (
                merchant_id,
                f"{prefix}-{number}",
                f"https://{prefix}.example/p/{number}",
                item["title"],
                item.get("brand"),
                f"https://cdn.example/{prefix}/{number}.jpg",
                json.dumps(item["attrs"]),
                10000 + number,
            ),
        )
        row = cur.fetchone()
        assert row is not None
        offer_id = int(row[0])
        item["id"] = offer_id
        for label, gtin in item.get("variants", []):
            cur.execute(
                "INSERT INTO offer_variant (offer_id, external_id, size_label, size_norm, in_stock,"
                " gtin) VALUES (%s, %s, %s, %s, TRUE, %s)",
                (offer_id, f"{offer_id}-{label}", label, label.lower(), gtin),
            )


def _dataset(size_a: int) -> tuple[list[dict], list[dict]]:
    rng = random.Random(7)
    a: list[dict] = []
    model = 0
    while len(a) < size_a:
        brand = BRANDS[model % len(BRANDS)]
        kind = KINDS[model % len(KINDS)]
        has_gtin = model % 9 == 0
        for color in COLORS:
            if len(a) >= size_a:
                break
            gtin = f"86900000{model:05d}" if has_gtin else None
            a.append(
                {
                    "title": f"{brand} Model {model} {kind} 0.{40 + model % 5}L {color}",
                    "brand": brand if model % 7 else None,  # bazilari markasiz
                    "attrs": {"color": color, **({"gtin": gtin} if gtin else {})},
                    "variants": [(size, gtin) for size in ("S", "M", "L")] if gtin else [],
                    "model": model,
                    "color": color,
                }
            )
        model += 1
    # ayni barkodu iki kez listeleyen offer (ayni merchant, ayni urun kimligi)
    a.append({**a[0], "title": a[0]["title"] + " Ikinci Liste", "variants": a[0]["variants"]})
    b: list[dict] = []
    for item in a[: size_a // 3]:
        if rng.random() < 0.8:
            b.append({**item, "title": item["title"], "variants": item["variants"]})
    return a, b


@pytest.fixture
def dataset(request: pytest.FixtureRequest) -> Iterator[Dataset]:
    size = getattr(request, "param", 1600)
    try:
        owner = _owner()
    except psycopg.OperationalError as error:  # pragma: no cover
        pytest.skip(f"yerel veritabani yok: {error}")

    items_a, items_b = _dataset(size)
    with owner:
        with owner.cursor() as cur:
            for statement in CLEANUP:
                cur.execute(statement, {"a": DOMAIN_A, "b": DOMAIN_B})
            ids = []
            for slug, domain in (("test-rb-a", DOMAIN_A), ("test-rb-b", DOMAIN_B)):
                cur.execute(
                    "INSERT INTO merchant (slug, name, domain, source_type) "
                    "VALUES (%s, %s, %s, 'xml_feed') RETURNING id",
                    (slug, slug, domain),
                )
                row = cur.fetchone()
                assert row is not None
                ids.append(int(row[0]))
            _make_offers(cur, ids[0], "rba", items_a)
            _make_offers(cur, ids[1], "rbb", items_b)
            # Insan karari: bir cift reddedilmis (ayni urune yeniden aday olmamali).
            cur.execute(
                "INSERT INTO product (slug, title) VALUES ('rbtest-onceden-reddedilen', "
                "'Rbtest Alfa Model 0 Termos 0.40L Siyah') RETURNING id"
            )
            row = cur.fetchone()
            assert row is not None
            cur.execute(
                "INSERT INTO match_candidate (offer_id, product_id, score, method, status) "
                "VALUES (%s, %s, 0.99, 'text', 'rejected')",
                (items_a[0]["id"], row[0]),
            )
        owner.commit()
        yield Dataset(ids[0], ids[1], len(items_a), len(items_b))
        with owner.cursor() as cur:
            for statement in CLEANUP:
                cur.execute(statement, {"a": DOMAIN_A, "b": DOMAIN_B})
        owner.commit()


OUTCOME = """
SELECT o.external_id,
       p.title, p.slug, p.color, p.gtin, p.mpn, b.name,
       (SELECT string_agg(mc.status || ':' || mc.method || ':' || mc.score::text || ':' || mp.title,
                          ',' ORDER BY mp.title, mc.status)
          FROM match_candidate mc JOIN product mp ON mp.id = mc.product_id
         WHERE mc.offer_id = o.id)
  FROM offer o
  JOIN merchant m ON m.id = o.merchant_id
  LEFT JOIN product p ON p.id = o.product_id
  LEFT JOIN brand b ON b.id = p.brand_id
 WHERE m.domain IN (%(a)s, %(b)s)
 ORDER BY o.external_id
"""


def _outcome(conn: psycopg.Connection) -> list[tuple]:
    with conn.cursor() as cur:
        cur.execute(OUTCOME, {"a": DOMAIN_A, "b": DOMAIN_B})
        return cur.fetchall()


def _run_in_rollback(runner) -> tuple[list[tuple], object, int, float]:  # type: ignore[no-untyped-def]
    """`runner(conn)` calistirir, sonucu okur, islemi GERI ALIR. Ifade sayisi ve sure doner."""
    executed = {"n": 0}
    real = psycopg.Cursor.execute

    def counting(self, query, params=None, **kwargs):  # type: ignore[no-untyped-def]
        executed["n"] += 1
        return real(self, query, params, **kwargs)

    psycopg.Cursor.execute = counting  # type: ignore[method-assign]
    try:
        with _app() as conn:
            started = time.perf_counter()
            counts = runner(conn)
            elapsed = time.perf_counter() - started
            statements = executed["n"]
            psycopg.Cursor.execute = real  # type: ignore[method-assign]
            outcome = _outcome(conn)
            conn.rollback()
    finally:
        psycopg.Cursor.execute = real  # type: ignore[method-assign]
    return outcome, counts, statements, elapsed


def test_batched_matches_sequential_on_a_large_catalog(dataset: Dataset) -> None:
    def sequential(conn):  # type: ignore[no-untyped-def]
        out = []
        for merchant in (dataset.merchant_a, dataset.merchant_b):
            out.append(resolve_offers_sequential(conn, limit=None, merchant_id=merchant))
        return out

    def batched(conn):  # type: ignore[no-untyped-def]
        out = []
        for merchant in (dataset.merchant_a, dataset.merchant_b):
            out.append(resolve_offers(conn, merchant_id=merchant))
        return out

    old_outcome, old_counts, old_statements, old_seconds = _run_in_rollback(sequential)
    new_outcome, new_counts, new_statements, new_seconds = _run_in_rollback(batched)

    total = dataset.offers_a + dataset.offers_b
    assert len(old_outcome) == total >= 1500
    assert new_outcome == old_outcome  # offer basina urun, slug, aday durumu/skoru AYNI
    for old, new in zip(old_counts, new_counts, strict=True):
        assert (new.considered, new.auto_accepted, new.queued, new.products_created) == (
            old.considered,
            old.auto_accepted,
            old.queued,
            old.products_created,
        )
    # Capraz eslesme gercekten oldu (yalnizca "hepsi yeni urun" degil).
    assert new_counts[1].auto_accepted > 100
    assert new_counts[0].products_created > 1000
    # Ifade sayisi offer sayisindan bagimsiz kabaca chunk sayisiyla orantili.
    print(
        f"\nRESOLVE-BENCH offers={total} sequential: {old_statements} ifade {old_seconds:.2f}s | "
        f"batched: {new_statements} ifade {new_seconds:.2f}s"
    )
    assert new_statements < old_statements / 20


@pytest.mark.parametrize("dataset", [700], indirect=True)
def test_no_duplicate_products_and_every_resolved_offer_has_one_canonical(dataset: Dataset) -> None:
    with _app() as conn:
        resolve_offers(conn, merchant_id=dataset.merchant_a, commit_each_chunk=True)
        resolve_offers(conn, merchant_id=dataset.merchant_b, commit_each_chunk=True)
        conn.commit()
    with _owner() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT count(*) FROM (SELECT slug FROM product GROUP BY slug HAVING count(*) > 1) d"
        )
        assert cur.fetchone() == (0,)
        # Ayni merchant'in iki offer'i (renk kardesleri) AYNI urune baglanmaz (barkodsuz).
        cur.execute(
            """SELECT count(*) FROM (
                 SELECT o.merchant_id, o.product_id
                   FROM offer o JOIN merchant m ON m.id = o.merchant_id
                  WHERE m.domain = %s AND o.product_id IS NOT NULL
                    AND o.attributes_raw->>'gtin' IS NULL
                  GROUP BY 1, 2 HAVING count(*) > 1) d""",
            (DOMAIN_A,),
        )
        assert cur.fetchone() == (0,)
        # Insanin reddettigi cift yeniden baglanmadi.
        cur.execute(
            """SELECT p.slug FROM offer o JOIN product p ON p.id = o.product_id
                WHERE o.external_id = 'rba-0'"""
        )
        row = cur.fetchone()
        assert row is None or row[0] != "rbtest-onceden-reddedilen"


@pytest.mark.parametrize("dataset", [700], indirect=True)
def test_rerun_is_idempotent(dataset: Dataset) -> None:
    with _app() as conn:
        resolve_offers(conn, merchant_id=dataset.merchant_a, commit_each_chunk=True)
        conn.commit()
    with _owner() as conn, conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM product")
        products_before = cur.fetchone()
        cur.execute("SELECT count(*) FROM match_candidate")
        candidates_before = cur.fetchone()
        outcome_before = _outcome(conn)

    with _app() as conn:
        again = resolve_offers(conn, merchant_id=dataset.merchant_a, commit_each_chunk=True)
        conn.commit()

    with _owner() as conn, conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM product")
        assert cur.fetchone() == products_before
        cur.execute("SELECT count(*) FROM match_candidate")
        assert cur.fetchone() == candidates_before
        assert _outcome(conn) == outcome_before
    assert again.products_created == 0  # zaten cozulmus offer'lar bir daha secilmez


@pytest.mark.parametrize("dataset", [700], indirect=True)
def test_failed_chunk_is_isolated_and_retry_completes(
    dataset: Dataset, monkeypatch: pytest.MonkeyPatch
) -> None:
    real = batch._Chunk.persist
    state = {"calls": 0, "armed": True}

    def flaky(self, decisions):  # type: ignore[no-untyped-def]
        state["calls"] += 1
        if state["armed"] and state["calls"] == 2:
            raise psycopg.errors.DataError("bozuk veri (test)")
        return real(self, decisions)

    monkeypatch.setattr(batch._Chunk, "persist", flaky)
    with _app() as conn:
        first = resolve_offers(
            conn, merchant_id=dataset.merchant_a, chunk_size=300, commit_each_chunk=True
        )
        conn.commit()

    assert len(first.errors) == 1  # ikinci chunk hata verdi, digerleri devam etti
    with _owner() as conn, conn.cursor() as cur:
        cur.execute(
            """SELECT count(*) FILTER (WHERE o.product_id IS NULL), count(*)
                 FROM offer o JOIN merchant m ON m.id = o.merchant_id WHERE m.domain = %s""",
            (DOMAIN_A,),
        )
        unresolved, total = cur.fetchone()  # type: ignore[misc]
    # 2. chunk (300 offer) cozulmedi; digerleri cozuldu (kuyruga dusenler haric).
    assert 300 <= unresolved < total

    state["armed"] = False
    with _app() as conn:
        second = resolve_offers(
            conn, merchant_id=dataset.merchant_a, chunk_size=300, commit_each_chunk=True
        )
        conn.commit()
    assert not second.errors
    assert second.products_created >= 300 - 5  # yalnizca kalan offer'lar islendi

    with _owner() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT count(*) FROM (SELECT slug FROM product GROUP BY slug HAVING count(*) > 1) d"
        )
        assert cur.fetchone() == (0,)
        cur.execute(
            """SELECT count(*) FROM offer o JOIN merchant m ON m.id = o.merchant_id
                WHERE m.domain = %s AND o.product_id IS NULL""",
            (DOMAIN_A,),
        )
        row = cur.fetchone()
    assert row is not None and row[0] <= 5  # yalnizca insan kuyruguna dusenler


@pytest.mark.parametrize("dataset", [700], indirect=True)
def test_partial_run_resumes_from_remaining_offers(dataset: Dataset) -> None:
    with _app() as conn:
        first = resolve_offers(
            conn, merchant_id=dataset.merchant_a, limit=500, chunk_size=200, commit_each_chunk=True
        )
        conn.commit()
    assert first.considered == 500
    with _app() as conn:
        rest = resolve_offers(
            conn, merchant_id=dataset.merchant_a, chunk_size=200, commit_each_chunk=True
        )
        conn.commit()
    assert rest.considered <= dataset.offers_a - 500 + 5
    with _owner() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT count(*) FROM (SELECT slug FROM product GROUP BY slug HAVING count(*) > 1) d"
        )
        assert cur.fetchone() == (0,)


@pytest.mark.parametrize("dataset", [700], indirect=True)
def test_chunk_is_single_merchant_and_ordered(dataset: Dataset) -> None:
    """Tum merchant'lar tek cagrida: merchant sirasiyla chunk'lanir; ikincisi
    birincinin urununu gorur."""
    with _app() as conn:
        counts = resolve_offers(conn, chunk_size=250, commit_each_chunk=True)
        conn.commit()
    assert counts.auto_accepted > 100  # B, A'nin urunlerine baglandi
