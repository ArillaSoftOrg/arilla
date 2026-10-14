"""Yonetici toplamasi: kota tetikleyicisi ve ara depo -> offer birlestirmesi (karar 0115).

Sentetik kayitlar; gercek Hepsiburada verisi ya da istegi YOK.
"""

from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime, timedelta

import psycopg
import pytest

from db.connection import database_url
from feeds.intake import NETWORK, merge_run, to_feed_row

pytestmark = pytest.mark.integration


def _owner() -> psycopg.Connection:
    return psycopg.connect(database_url("DATABASE_URL_OWNER"), autocommit=True)


def _cleanup(cur: psycopg.Cursor) -> None:
    cur.execute("SELECT id FROM merchant WHERE slug = 'hepsiburada'")
    row = cur.fetchone()
    feeds = f"SELECT id FROM feed_source WHERE network = '{NETWORK}'"
    if row:
        offers = f"SELECT id FROM offer WHERE merchant_id = {row[0]}"
        cur.execute(f"DELETE FROM search_outbox WHERE entity='offer' AND entity_id IN ({offers})")
        cur.execute(f"DELETE FROM price_point WHERE offer_id IN ({offers})")
        cur.execute(f"DELETE FROM offer_image WHERE offer_id IN ({offers})")
        cur.execute(f"DELETE FROM feed_source_offer WHERE offer_id IN ({offers})")
    cur.execute("DELETE FROM catalog_intake_record")
    cur.execute("DELETE FROM collection_unit")
    cur.execute("DELETE FROM ingest_error WHERE feed_source_id IN (" + feeds + ")")
    cur.execute(
        "DELETE FROM ingest_chunk WHERE snapshot_id IN "
        f"(SELECT id FROM source_snapshot WHERE feed_source_id IN ({feeds}))"
    )
    cur.execute(f"DELETE FROM ingest_run WHERE feed_source_id IN ({feeds})")
    if row:
        cur.execute("DELETE FROM offer WHERE merchant_id = %s", (row[0],))
        cur.execute("DELETE FROM seller WHERE merchant_id = %s", (row[0],))
    cur.execute(f"DELETE FROM source_snapshot WHERE feed_source_id IN ({feeds})")
    cur.execute(f"DELETE FROM feed_source WHERE network = '{NETWORK}'")
    cur.execute("DELETE FROM collection_run")
    cur.execute("DELETE FROM merchant WHERE slug = 'hepsiburada'")
    cur.execute("UPDATE collection_source SET enabled = FALSE WHERE source = 'hepsiburada'")


@pytest.fixture
def env() -> Iterator[psycopg.Connection]:
    owner = _owner()
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


def _new_run(owner: psycopg.Connection) -> int:
    with owner.cursor() as cur:
        cur.execute(
            "INSERT INTO collection_run (source, expires_at, max_requests)"
            " VALUES ('hepsiburada', now(), 1) RETURNING id"
        )
        row = cur.fetchone()
    assert row
    return int(row[0])


def _add(owner: psycopg.Connection, run_id: int, ext: str, price: int, **kw: object) -> None:
    with owner.cursor() as cur:
        cur.execute(
            """INSERT INTO catalog_intake_record
                   (run_id, external_id, title, url, price_minor, currency, in_stock, image_url,
                    brand, source_observed_at)
               VALUES (%s, %s, %s, %s, %s, 'TRY', %s, %s, %s, now())""",
            (
                run_id,
                ext,
                f"Test urun {ext}",
                f"https://www.hepsiburada.com/test-urun-p-{ext}",
                price,
                kw.get("in_stock", True),
                f"https://productimages.hepsiburada.net/s/{ext}.jpg",
                kw.get("brand"),
            ),
        )


def _close(owner: psycopg.Connection, run_id: int, requests: int = 3) -> None:
    with owner.cursor() as cur:
        cur.execute(
            "UPDATE collection_run SET requests_made = %s WHERE id = %s", (requests, run_id)
        )
        cur.execute("UPDATE collection_run SET status = 'completed' WHERE id = %s", (run_id,))


def _rewind(owner: psycopg.Connection, days: int) -> None:
    with owner.cursor() as cur:
        cur.execute("ALTER TABLE collection_run DISABLE TRIGGER collection_run_immutable_guard_trg")
        cur.execute(
            "UPDATE collection_run SET reserved_at = reserved_at - make_interval(days => %s)",
            (days,),
        )
        cur.execute("ALTER TABLE collection_run ENABLE TRIGGER collection_run_immutable_guard_trg")


def _expect(owner: psycopg.Connection, code: str) -> None:
    with pytest.raises(psycopg.Error) as info, owner.cursor() as cur:
        cur.execute(
            "INSERT INTO collection_run (source, expires_at, max_requests)"
            " VALUES ('hepsiburada', now(), 1)"
        )
    assert code in str(info.value)


def test_kota_aralik_ve_acik_kosu(env: psycopg.Connection) -> None:
    first = _new_run(env)
    _expect(env, "collection_quota_interval")  # acik kosu da aralik sayar: ikinci kosu yok
    _close(env, first)
    _expect(env, "collection_quota_interval")  # 7 gun dolmadan yeni kosu yok
    _rewind(env, 8)
    second = _new_run(env)  # aralik doldu
    assert second > first


def test_aylik_tavan_aralik_dolsa_bile_zorunlu(env: psycopg.Connection) -> None:
    today = datetime.now(UTC)
    if today.day < 12:
        pytest.skip("ay icinde 4 kosuyu 2 gun arayla gecmise yerlestirmek icin ayin 12'si gerekir")
    with env.cursor() as cur:
        cur.execute("ALTER TABLE collection_source DISABLE TRIGGER ALL")
        cur.execute("UPDATE collection_source SET min_interval_days = 2, run_window_days = 1")
        cur.execute("ALTER TABLE collection_source ENABLE TRIGGER ALL")
        cur.execute("ALTER TABLE collection_run DISABLE TRIGGER collection_run_quota_guard_trg")
        cur.execute(
            """INSERT INTO collection_run (source, status, reserved_at, expires_at, closed_at,
                                           requests_made, max_requests)
               SELECT 'hepsiburada', 'completed', date_trunc('month', now())
                      + g * interval '2 days',
                      now(), now(), 1, 500 FROM generate_series(1, 4) g"""
        )
        cur.execute("ALTER TABLE collection_run ENABLE TRIGGER collection_run_quota_guard_trg")
    try:
        _expect(env, "collection_quota_month")
    finally:
        with env.cursor() as cur:
            cur.execute("UPDATE collection_source SET min_interval_days = 7, run_window_days = 6")


def test_kullanilmadan_birakilan_kosu_kotadan_dusulur(env: psycopg.Connection) -> None:
    run = _new_run(env)
    with env.cursor() as cur:
        cur.execute("UPDATE collection_run SET status = 'released' WHERE id = %s", (run,))
    again = _new_run(env)  # released kota harcamaz
    assert again > run


def test_kapali_kaynak_ve_kapali_kosu_degismez(env: psycopg.Connection) -> None:
    run = _new_run(env)
    _close(env, run)
    with pytest.raises(psycopg.Error) as info, env.cursor() as cur:
        cur.execute("UPDATE collection_run SET status = 'open' WHERE id = %s", (run,))
    assert "collection_run_closed" in str(info.value)
    with env.cursor() as cur:
        cur.execute("UPDATE collection_source SET enabled = FALSE WHERE source = 'hepsiburada'")
    _rewind(env, 8)
    _expect(env, "collection_disabled")


def test_ara_depo_yalniz_acik_kosuya_ve_tekrar_etmeyen(env: psycopg.Connection) -> None:
    run = _new_run(env)
    _add(env, run, "HBTEST0001", 129900)
    with pytest.raises(psycopg.errors.UniqueViolation):
        _add(env, run, "HBTEST0001", 129900)
    with pytest.raises(psycopg.Error) as info, env.cursor() as cur:
        cur.execute(
            """INSERT INTO catalog_intake_record (run_id, external_id, title, url, price_minor,
                   currency, source_observed_at)
               VALUES (%s, 'X1', 't', 'https://www.hepsiburada.com/x-p-X1', 100, 'TRY',
                       now() - interval '2 days')""",
            (run,),
        )
    assert "collection_observed_at_out_of_range" in str(info.value)
    _close(env, run)
    with pytest.raises(psycopg.Error) as info2:
        _add(env, run, "HBTEST0002", 100)
    assert "collection_run_not_open" in str(info2.value)


def _offer_state(owner: psycopg.Connection) -> dict[str, tuple[int, bool, int]]:
    with owner.cursor() as cur:
        cur.execute(
            """SELECT o.external_id, o.current_price, o.is_active,
                      (SELECT count(*) FROM price_point p WHERE p.offer_id = o.id)
                 FROM offer o JOIN merchant m ON m.id = o.merchant_id
                WHERE m.slug = 'hepsiburada'"""
        )
        return {r[0]: (int(r[1]), bool(r[2]), int(r[3])) for r in cur.fetchall()}


def test_birlestirme_fiyat_gecmisi_degismeyeni_yazmaz_eksigi_silmez(
    env: psycopg.Connection,
) -> None:
    run1 = _new_run(env)
    _add(env, run1, "HBTEST0001", 129900, brand="Marka")
    _add(env, run1, "HBTEST0002", 50000)
    _add(env, run1, "HBTEST0003", 70000, in_stock=None)
    _close(env, run1)
    with psycopg.connect(database_url("DATABASE_URL")) as app:
        first = merge_run(app, run1)
    assert first.status == "success" and first.records == 3
    state = _offer_state(env)
    assert state["HBTEST0001"] == (129900, True, 1)
    with env.cursor() as cur:
        cur.execute("SELECT in_stock, attributes_raw FROM offer WHERE external_id = 'HBTEST0003'")
        stock, attrs = cur.fetchone()  # type: ignore[misc]
        assert stock is False and attrs.get("stock_state") == "unknown"  # uydurma "stokta" yok
        cur.execute("SELECT count(*) FROM catalog_intake_record WHERE merged_at IS NULL")
        assert cur.fetchone() == (0,)

    # 8 gun sonra ikinci kosu: biri degisti, biri ayni, biri HIC GELMEDI.
    _rewind(env, 8)
    run2 = _new_run(env)
    _add(env, run2, "HBTEST0001", 119900, brand="Marka")  # fiyat dustu
    _add(env, run2, "HBTEST0002", 50000)  # ayni
    _close(env, run2)
    with psycopg.connect(database_url("DATABASE_URL")) as app:
        second = merge_run(app, run2)
    assert second.status == "success"
    state = _offer_state(env)
    assert state["HBTEST0001"] == (119900, True, 2)  # yeni fiyat noktasi
    assert state["HBTEST0002"] == (50000, True, 1)  # degismeyen: yeni nokta yok
    assert state["HBTEST0003"][1] is True  # eksik gelen urun PASIFLESMEZ
    with env.cursor() as cur:
        cur.execute("SELECT count(*) FROM offer WHERE deactivated_at IS NOT NULL")
        assert cur.fetchone() == (0,)


def test_acik_kosu_birlestirilmez(env: psycopg.Connection) -> None:
    run = _new_run(env)
    _add(env, run, "HBTEST0001", 100)
    with psycopg.connect(database_url("DATABASE_URL")) as app, pytest.raises(RuntimeError):
        merge_run(app, run)


def test_ndjson_satiri_bilinmeyeni_uydurmaz() -> None:
    row = (
        1,
        "E1",
        "T",
        "https://www.hepsiburada.com/t-p-E1",
        12345,
        None,
        "TRY",
        True,
        None,
        None,
        None,
        None,
        None,
        None,
        datetime.now(UTC) - timedelta(minutes=1),
    )
    record = to_feed_row(row)
    assert record["price"] == "123.45"
    for missing in ("brand", "gtin", "seller", "images", "list_price", "category"):
        assert missing not in record
