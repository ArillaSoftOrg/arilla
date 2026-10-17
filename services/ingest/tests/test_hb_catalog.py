"""Hepsiburada iki toplayicinin merkezi katalogda birlesmesi (karar 0130). Gercek PostgreSQL.

Akis: ara depo -> hb-merge -> offer (+ kesif defteri isareti) -> catalog_build build ->
taslak -> kapi -> acik yayin. Sitemap defteri -> build-discovery -> fiyatsiz taslak (offer
YOK) -> held; ayni kod + ayni turde fiyatli teklif gelince bag kurulur.

Sentetik kayitlar; gercek Hepsiburada verisi ya da istegi YOK.
"""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any

import psycopg
import pytest
from test_hb_intake import _cleanup as _intake_cleanup
from test_hb_intake import _close, _new_run, _rewind

from catalog_build import build as build_mod
from catalog_build import discovery as discovery_mod
from catalog_build import gate as gate_mod
from catalog_build import publish as publish_mod
from db.connection import database_url
from feeds.intake import merge_run
from resolve.pipeline import PENDING_OFFERS

pytestmark = pytest.mark.integration

OTHER = "test-hbc-other"
IMG = "https://productimages.hepsiburada.net/s/{}.jpg"


def _owner() -> psycopg.Connection:
    return psycopg.connect(database_url("DATABASE_URL_OWNER"), autocommit=True)


def _app() -> psycopg.Connection:
    return psycopg.connect(database_url("DATABASE_URL"))


def _cleanup(cur: psycopg.Cursor) -> None:
    hb = "(SELECT id FROM merchant WHERE slug IN ('hepsiburada', %(other)s))"
    products = f"SELECT id FROM product WHERE source_merchant_id IN {hb} OR slug LIKE 'test-hbc-%%'"
    offers = f"SELECT id FROM offer WHERE merchant_id IN {hb}"
    p = {"other": OTHER}
    cur.execute(
        f"DELETE FROM search_outbox WHERE entity = 'product' AND entity_id IN ({products})", p
    )
    cur.execute(f"DELETE FROM match_decision_log WHERE offer_id IN ({offers})", p)
    cur.execute(f"UPDATE offer SET product_id = NULL WHERE id IN ({offers})", p)
    cur.execute(f"DELETE FROM product WHERE id IN ({products})", p)
    cur.execute(f"DELETE FROM catalog_build_state WHERE merchant_id IN {hb}", p)
    cur.execute("DELETE FROM catalog_discovery_build_state")
    cur.execute("DELETE FROM catalog_discovery")
    cur.execute(f"DELETE FROM price_point WHERE offer_id IN ({offers})", p)
    cur.execute(
        "DELETE FROM offer WHERE merchant_id IN (SELECT id FROM merchant WHERE slug = %s)", (OTHER,)
    )
    cur.execute("DELETE FROM merchant WHERE slug = %s", (OTHER,))
    _intake_cleanup(cur)


@pytest.fixture
def env() -> Iterator[psycopg.Connection]:
    try:
        owner = _owner()
    except psycopg.OperationalError as error:  # pragma: no cover
        pytest.skip(f"yerel veritabani yok: {error}")
    with owner.cursor() as cur:
        _cleanup(cur)
        cur.execute(
            """INSERT INTO merchant (slug, name, domain, source_type, is_active)
               VALUES ('hepsiburada', 'Hepsiburada', 'hepsiburada.com', 'user_discovered', TRUE)"""
        )
        cur.execute("UPDATE collection_source SET enabled = TRUE WHERE source = 'hepsiburada'")
    try:
        yield owner
    finally:
        with owner.cursor() as cur:
            _cleanup(cur)
        owner.close()


def add(
    owner: psycopg.Connection,
    run_id: int,
    code: str,
    price: int,
    *,
    kind: str = "p",
    in_stock: bool | None = True,
) -> None:
    with owner.cursor() as cur:
        cur.execute(
            """INSERT INTO catalog_intake_record
                   (run_id, external_id, title, url, price_minor, currency, in_stock, image_url,
                    source_observed_at)
               VALUES (%s, %s, %s, %s, %s, 'TRY', %s, %s, now())""",
            (
                run_id,
                code,
                f"Test urun numara {code}",
                f"https://www.hepsiburada.com/test-urun-{kind}-{code}",
                price,
                in_stock,
                IMG.format(code),
            ),
        )


def discover(
    owner: psycopg.Connection,
    run_id: int,
    code: str,
    *,
    kind: str = "pm",
    title: str | None = None,
    image: bool = True,
) -> None:
    with owner.cursor() as cur:
        cur.execute(
            """INSERT INTO catalog_discovery (source, external_id, code_kind, url, title, image_url,
                                              source_unit_key, first_seen_run_id, last_seen_run_id)
               VALUES ('hepsiburada', %s, %s, %s, %s, %s, 'product/sitemap-1.xml', %s, %s)""",
            (
                code,
                kind,
                f"https://www.hepsiburada.com/kesif-urun-{kind}-{code}",
                # "" = sitemap'te ad yok (NULL).
                (title or None) if title is not None else f"Kesif urunu numara {code}",
                IMG.format(code) if image else None,
                run_id,
                run_id,
            ),
        )


def merge(run_id: int):
    with _app() as conn:
        return merge_run(conn, run_id)


def one(owner: psycopg.Connection, sql: str, *params: Any) -> Any:
    with owner.cursor() as cur:
        cur.execute(sql, params)
        row = cur.fetchone()
    return row


def all_rows(owner: psycopg.Connection, sql: str, *params: Any) -> list[tuple[Any, ...]]:
    with owner.cursor() as cur:
        cur.execute(sql, params)
        return cur.fetchall()


def hb_id(owner: psycopg.Connection) -> int:
    return int(one(owner, "SELECT id FROM merchant WHERE slug = 'hepsiburada'")[0])


def build(**kw: Any) -> build_mod.BuildCounts:
    with _app() as conn:
        return build_mod.build_source_products(conn, merchant_slug="hepsiburada", **kw)


def build_discovery(limit: int = 100, **kw: Any) -> discovery_mod.DiscoveryBuildCounts:
    with _app() as conn:
        return discovery_mod.build_discovery_products(
            conn, merchant_slug="hepsiburada", limit=limit, **kw
        )


def gate() -> gate_mod.GateCounts:
    with _app() as conn:
        return gate_mod.run_gate(conn)


def publish(limit: int = 100) -> publish_mod.PublishCounts:
    with _app() as conn:
        return publish_mod.publish_ready(conn, limit=limit)


def products(owner: psycopg.Connection) -> dict[str, tuple[Any, ...]]:
    rows = all_rows(
        owner,
        """SELECT p.source_external_id, p.publication_state, p.hold_reason, p.source_offer_id
             FROM product p WHERE p.source_merchant_id = %s""",
        hb_id(owner),
    )
    return {r[0]: r[1:] for r in rows}


def stock(owner: psycopg.Connection, code: str) -> tuple[bool, str | None]:
    row = one(
        owner,
        "SELECT in_stock, attributes_raw->>'stock_state' FROM offer WHERE external_id = %s",
        code,
    )
    return bool(row[0]), row[1]


# --------------------------------------------------------------------------- stok


def test_stok_uc_durumlu_ve_sonraki_kosu_bilinmeyeni_ezer(env: psycopg.Connection) -> None:
    run1 = _new_run(env)
    add(env, run1, "HBCVS0001", 10000, in_stock=True)
    add(env, run1, "HBCVS0002", 10000, in_stock=False)
    add(env, run1, "HBCVS0003", 10000, in_stock=None)
    _close(env, run1)
    assert merge(run1).status == "success"
    assert stock(env, "HBCVS0001") == (True, "available")
    assert stock(env, "HBCVS0002") == (False, "unavailable")
    assert stock(env, "HBCVS0003") == (False, "unknown")  # "stokta yok" DEGIL

    _rewind(env, 8)
    run2 = _new_run(env)
    add(env, run2, "HBCVS0003", 10000, in_stock=True)  # artik biliniyor
    _close(env, run2)
    assert merge(run2).status == "success"
    assert stock(env, "HBCVS0003") == (True, "available")  # eski "unknown" kalmadi


# --------------------------------------------------------------------------- idempotens


def test_birlestirme_idempotent_ve_eszamanli_kosu_reddedilir(env: psycopg.Connection) -> None:
    run = _new_run(env)
    add(env, run, "HBCVI0001", 10000)
    add(env, run, "HBCVI0002", 20000)
    _close(env, run)
    with _app() as holder:
        with holder.cursor() as cur:
            cur.execute(
                "SELECT pg_advisory_lock(hashtextextended('hb_merge:' || %s::text, 0))", (run,)
            )
        holder.commit()
        with pytest.raises(RuntimeError, match="run_merge_in_progress"):
            merge(run)
    assert merge(run).status == "success"
    assert merge(run).status == "nothing_to_merge"
    assert one(env, "SELECT count(*) FROM offer WHERE merchant_id = %s", hb_id(env)) == (2,)
    assert one(env, "SELECT count(*) FROM product WHERE source_merchant_id = %s", hb_id(env)) == (
        0,
    )


def test_cozumleyici_hepsiburada_teklifinden_urun_acmaz(env: psycopg.Connection) -> None:
    run = _new_run(env)
    add(env, run, "HBCVR0001", 10000)
    _close(env, run)
    merge(run)
    with env.cursor() as cur:
        cur.execute(
            PENDING_OFFERS,
            {"merchant_id": hb_id(env), "limit": 100, "source_listing": ["hepsiburada"]},
        )
        assert cur.fetchall() == []
        # Ayni sorgu dislama olmadan teklifi secerdi: dislama gercekten etkili.
        cur.execute(PENDING_OFFERS, {"merchant_id": hb_id(env), "limit": 100, "source_listing": []})
        assert len(cur.fetchall()) == 1


# --------------------------------------------------------------------------- arama hatti


def test_arama_toplayicisi_taslak_kapi_acik_yayin(env: psycopg.Connection) -> None:
    run = _new_run(env)
    add(env, run, "HBCVA0001", 129900, in_stock=None)
    add(env, run, "HBCVA0002", 49900)
    _close(env, run)
    merge(run)

    first = build()
    assert (first.created, first.completed) == (2, True)
    got = products(env)
    assert {k: v[0] for k, v in got.items()} == {"HBCVA0001": "draft", "HBCVA0002": "draft"}
    # Taslak teklife BAGLANMAZ ve aramaya girmez.
    assert one(
        env,
        "SELECT count(*) FROM offer WHERE product_id IS NOT NULL AND merchant_id = %s",
        hb_id(env),
    ) == (0,)
    again = build(rescan=True)
    assert (again.created, again.existing) == (0, 2)  # ikinci kosu yeni urun uretmez

    assert gate().ready == 2
    published = publish()
    assert published.published == 2
    rows = all_rows(
        env,
        """SELECT p.source_external_id, p.publication_state, o.current_price, o.url, p.min_price
             FROM product p JOIN offer o ON o.product_id = p.id
            WHERE p.source_merchant_id = %s ORDER BY 1""",
        hb_id(env),
    )
    assert rows == [
        (
            "HBCVA0001",
            "published",
            129900,
            "https://www.hepsiburada.com/test-urun-p-HBCVA0001",
            129900,
        ),
        (
            "HBCVA0002",
            "published",
            49900,
            "https://www.hepsiburada.com/test-urun-p-HBCVA0002",
            49900,
        ),
    ]


# --------------------------------------------------------------------------- sitemap hatti


def test_kesif_fiyatsiz_taslak_offer_acmaz_ve_yayina_cikmaz(env: psycopg.Connection) -> None:
    run = _new_run(env)
    discover(env, run, "HBC0000D0001")
    discover(env, run, "HBC0000D0002", title="")  # adsiz: urun olmaz
    discover(env, run, "HBC0000D0003", image=False)  # gorselsiz: urun olmaz
    _close(env, run)

    dry = build_discovery(dry_run=True)
    assert dry.created == 1
    assert products(env) == {}  # kuru kosu hicbir sey yazmaz

    counts = build_discovery()
    assert (counts.created, counts.completed) == (1, True)
    assert counts.skipped == {"no_title": 1, "no_image": 1}
    assert one(env, "SELECT count(*) FROM offer WHERE merchant_id = %s", hb_id(env)) == (0,)
    assert one(
        env,
        "SELECT count(*) FROM price_point pp JOIN offer o ON o.id = pp.offer_id"
        " WHERE o.merchant_id = %s",
        hb_id(env),
    ) == (0,)

    assert build_discovery().created == 0  # kontrol noktasi: kaldigi yerden, tekrar yok
    assert build_discovery(rescan=True).existing == 1

    gate()
    assert products(env)["HBC0000D0001"] == ("held", "source_offer_missing", None)
    assert publish().published == 0


def test_kesif_limit_ve_kontrol_noktasi(env: psycopg.Connection) -> None:
    run = _new_run(env)
    for n in range(5):
        discover(env, run, f"HBC0000L000{n}")
    _close(env, run)
    first = build_discovery(limit=2, batch_size=1)
    assert (first.scanned, first.created, first.completed) == (2, 2, False)
    rest = build_discovery(limit=100)
    assert (rest.scanned, rest.created, rest.completed) == (3, 3, True)
    state = one(
        env, "SELECT scanned, created, completed_at IS NOT NULL FROM catalog_discovery_build_state"
    )
    assert state == (5, 5, True)


# --------------------------------------------------------------------------- iki hattin birlesmesi


def test_ayni_kod_ve_tur_tek_urunde_birlesir(env: psycopg.Connection) -> None:
    run1 = _new_run(env)
    discover(env, run1, "HBC0000M0001", kind="pm")
    _close(env, run1)
    build_discovery()
    gate()
    pid_before = one(env, "SELECT id FROM product WHERE source_external_id = 'HBC0000M0001'")[0]

    _rewind(env, 8)
    run2 = _new_run(env)
    add(env, run2, "HBC0000M0001", 99900, kind="pm")
    _close(env, run2)
    report = merge(run2)
    assert (report.discovery_marked, report.discovery_kind_mismatch) == (1, 0)
    assert one(
        env,
        "SELECT price_state, price_checked_at IS NOT NULL FROM catalog_discovery"
        " WHERE external_id = 'HBC0000M0001'",
    ) == ("listing_price", True)

    counts = build()
    assert (counts.created, counts.attached) == (0, 1)
    got = products(env)
    assert len(got) == 1  # ikinci urun YOK
    assert got["HBC0000M0001"][2] is not None
    gate()
    assert publish().published == 1
    row = one(
        env,
        """SELECT p.id, p.publication_state, o.current_price FROM product p
             JOIN offer o ON o.product_id = p.id WHERE p.source_external_id = 'HBC0000M0001'""",
    )
    assert row == (pid_before, "published", 99900)


def test_p_ve_pm_kodlari_birbirine_baglanmaz(env: psycopg.Connection) -> None:
    run1 = _new_run(env)
    # Ayni kod dizisi defterde MODEL adresiyle, teklifte VARYANT adresiyle: iliski dogrulanmadi.
    discover(env, run1, "HBCK00001", kind="pm")
    _close(env, run1)
    build_discovery()

    _rewind(env, 8)
    run2 = _new_run(env)
    add(env, run2, "HBCK00001", 10000, kind="p")
    _close(env, run2)
    report = merge(run2)
    assert (report.discovery_marked, report.discovery_kind_mismatch) == (0, 1)
    assert one(
        env, "SELECT price_state FROM catalog_discovery WHERE external_id = 'HBCK00001'"
    ) == ("unpriced",)
    counts = build()
    assert counts.attached == 0
    assert counts.skipped.get("discovery_kind_conflict") == 1
    assert products(env)["HBCK00001"][2] is None  # fiyat teklifi baska turun taslagina gecmedi


def test_kesif_tur_cakismasi_teklif_urununu_degistirmez(env: psycopg.Connection) -> None:
    run1 = _new_run(env)
    add(env, run1, "HBCK00002", 10000, kind="p")
    _close(env, run1)
    merge(run1)
    build()
    _rewind(env, 8)
    run2 = _new_run(env)
    discover(env, run2, "HBCK00002", kind="pm")
    _close(env, run2)
    counts = build_discovery()
    assert counts.created == 0
    assert counts.skipped.get("discovery_kind_conflict") == 1


def test_baska_magazanin_ayni_kimlikli_urunu_ile_birlesmez(env: psycopg.Connection) -> None:
    """AliExpress benzeri baska kaynakta ayni kimlik dizisi: anahtar magaza kapsamlidir."""
    with env.cursor() as cur:
        cur.execute(
            """INSERT INTO merchant (slug, name, domain, source_type, is_active)
               VALUES (%s, 'Diger', 'diger.example', 'xml_feed', TRUE) RETURNING id""",
            (OTHER,),
        )
        other = cur.fetchone()[0]  # type: ignore[index]
        cur.execute(
            """INSERT INTO offer (merchant_id, external_id, url, title_raw, image_url,
                                  current_price, currency)
               VALUES (%s, 'HBCVX0001', 'https://diger.example/x', 'Test urun numara HBCVX0001',
                       %s, 1999, 'USD') RETURNING id""",
            (other, IMG.format("x")),
        )
        other_offer = cur.fetchone()[0]  # type: ignore[index]
        cur.execute(
            """INSERT INTO product (slug, title, primary_image_url, source_merchant_id,
                                    source_external_id, source_offer_id, publication_state)
               VALUES ('test-hbc-diger-HBCVX0001', 'Test urun numara HBCVX0001', %s, %s,
                       'HBCVX0001', %s, 'draft') RETURNING id""",
            (IMG.format("x"), other, other_offer),
        )
        other_product = cur.fetchone()[0]  # type: ignore[index]

    run = _new_run(env)
    add(env, run, "HBCVX0001", 10000)
    _close(env, run)
    merge(run)
    assert build().created == 1
    gate()
    publish()
    hb_product = one(env, "SELECT id FROM product WHERE source_merchant_id = %s", hb_id(env))[0]
    assert hb_product != other_product
    assert one(env, "SELECT product_id, currency FROM offer WHERE id = %s", other_offer) == (
        None,
        "USD",
    )
    assert one(
        env, "SELECT publication_state, source_offer_id FROM product WHERE id = %s", other_product
    ) == ("draft", other_offer)
