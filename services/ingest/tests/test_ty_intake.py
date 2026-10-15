"""Trendyol yonetici toplamasi (karar 0118): kota, ara depo -> offer birlestirmesi.

Sentetik kayitlar; gercek Trendyol verisi ya da istegi YOK. Hepsiburada testleriyle (0117)
ayni tetikleyici ve birlestirme hatti; burada Trendyol'a ozgu kurallar sinanir:
satis fiyati / kosullu sepet fiyati ayrimi, ana satici, coklu gorsel, varyant, tekrar etmeme,
degismeyen urunu yeniden yazmama (WAL) ve eksik urunu pasiflestirmeme.
"""

from __future__ import annotations

import json
from collections.abc import Iterator

import psycopg
import pytest

from db.connection import database_url
from feeds.intake import SOURCES, merge_run, to_feed_row

pytestmark = pytest.mark.integration

NETWORK = SOURCES["trendyol"].network


def _owner() -> psycopg.Connection:
    return psycopg.connect(database_url("DATABASE_URL_OWNER"), autocommit=True)


def _cleanup(cur: psycopg.Cursor) -> None:
    cur.execute("SELECT id FROM merchant WHERE slug = 'trendyol'")
    row = cur.fetchone()
    feeds = f"SELECT id FROM feed_source WHERE network = '{NETWORK}'"
    if row:
        offers = f"SELECT id FROM offer WHERE merchant_id = {row[0]}"
        cur.execute(f"DELETE FROM search_outbox WHERE entity='offer' AND entity_id IN ({offers})")
        cur.execute(f"DELETE FROM price_point WHERE offer_id IN ({offers})")
        cur.execute(f"DELETE FROM offer_image WHERE offer_id IN ({offers})")
        cur.execute(f"DELETE FROM feed_source_offer WHERE offer_id IN ({offers})")
    cur.execute(
        "DELETE FROM catalog_intake_record WHERE run_id IN"
        " (SELECT id FROM collection_run WHERE source = 'trendyol')"
    )
    cur.execute(
        "DELETE FROM collection_unit WHERE run_id IN"
        " (SELECT id FROM collection_run WHERE source = 'trendyol')"
    )
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
    cur.execute("DELETE FROM collection_run WHERE source = 'trendyol'")
    cur.execute("DELETE FROM merchant WHERE slug = 'trendyol'")
    cur.execute("UPDATE collection_source SET enabled = FALSE WHERE source = 'trendyol'")


@pytest.fixture
def env() -> Iterator[psycopg.Connection]:
    owner = _owner()
    with owner.cursor() as cur:
        _cleanup(cur)
        cur.execute(
            """INSERT INTO merchant (slug, name, domain, source_type, is_active)
               VALUES ('trendyol', 'Trendyol', 'trendyol.com', 'user_discovered', TRUE)"""
        )
        cur.execute("UPDATE collection_source SET enabled = TRUE WHERE source = 'trendyol'")
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
            " VALUES ('trendyol', now(), 1) RETURNING id"
        )
        row = cur.fetchone()
    assert row
    return int(row[0])


def _add(owner: psycopg.Connection, run_id: int, cid: str, price: int, **kw: object) -> None:
    images = kw.get(
        "images",
        [
            f"https://cdn.dsmcdn.com/ty1/prod/{cid}/1_org_zoom.jpg",
            f"https://cdn.dsmcdn.com/ty1/prod/{cid}/2_org_zoom.jpg",
        ],
    )
    with owner.cursor() as cur:
        cur.execute(
            """INSERT INTO catalog_intake_record
                   (run_id, external_id, title, url, price_minor, list_price_minor, currency,
                    in_stock, image_url, image_urls, brand, seller_external_id, seller_name,
                    group_external_id, variant_external_id, variant_label, basket_price_minor,
                    source_page, source_observed_at)
               VALUES (%s, %s, %s, %s, %s, %s, 'TRY', NULL, %s, %s::jsonb, %s, %s, %s, %s, %s,
                       %s, %s, %s, now())""",
            (
                run_id,
                cid,
                f"Marka Test urun {cid}",
                f"https://www.trendyol.com/marka/test-urun-p-{cid}",
                price,
                kw.get("list_price"),
                images[0] if images else None,  # type: ignore[index]
                json.dumps(images) if images else None,
                "Marka",
                kw.get("seller", "106871"),
                kw.get("seller_name", "Test Satici"),
                "621971282",
                kw.get("variant_id"),
                kw.get("variant_label"),
                kw.get("basket"),
                kw.get("page", "product_page"),
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
            "UPDATE collection_run SET reserved_at = reserved_at - make_interval(days => %s)"
            " WHERE source = 'trendyol'",
            (days,),
        )
        cur.execute("ALTER TABLE collection_run ENABLE TRIGGER collection_run_immutable_guard_trg")


def _merge(run_id: int) -> object:
    with psycopg.connect(database_url("DATABASE_URL")) as app:
        return merge_run(app, run_id)


def _offers(owner: psycopg.Connection) -> dict[str, dict[str, object]]:
    with owner.cursor() as cur:
        cur.execute(
            """SELECT o.external_id, o.current_price, o.list_price, o.is_active, o.in_stock,
                      o.attributes_raw, o.url, o.xmin::text, sl.external_id,
                      (SELECT count(*) FROM price_point p WHERE p.offer_id = o.id),
                      (SELECT count(*) FROM offer_image i WHERE i.offer_id = o.id)
                 FROM offer o JOIN merchant m ON m.id = o.merchant_id
                 LEFT JOIN seller sl ON sl.id = o.seller_id
                WHERE m.slug = 'trendyol'"""
        )
        return {
            r[0]: {
                "price": r[1],
                "list": r[2],
                "active": r[3],
                "in_stock": r[4],
                "attrs": r[5],
                "url": r[6],
                "xmin": r[7],
                "seller": r[8],
                "points": int(r[9]),
                "images": int(r[10]),
            }
            for r in cur.fetchall()
        }


def test_kota_trendyol_icin_de_sistem_seviyesinde(env: psycopg.Connection) -> None:
    run = _new_run(env)
    with pytest.raises(psycopg.Error) as info, env.cursor() as cur:
        cur.execute(
            "INSERT INTO collection_run (source, expires_at, max_requests)"
            " VALUES ('trendyol', now(), 1)"
        )
    assert "collection_quota_interval" in str(info.value)  # ilk yukleme dahil: ikinci kosu yok
    _close(env, run)
    with env.cursor() as cur:
        cur.execute("UPDATE collection_source SET enabled = FALSE WHERE source = 'trendyol'")
    _rewind(env, 8)
    with pytest.raises(psycopg.Error) as info2, env.cursor() as cur:
        cur.execute(
            "INSERT INTO collection_run (source, expires_at, max_requests)"
            " VALUES ('trendyol', now(), 1)"
        )
    assert "collection_disabled" in str(info2.value)


def test_politika_varsayilan_kapali_ve_sozlu_izin() -> None:
    with _owner() as owner, owner.cursor() as cur:
        cur.execute(
            """SELECT enabled, min_interval_days, max_runs_per_month, permission_basis
                 FROM collection_source WHERE source = 'trendyol'"""
        )
        assert cur.fetchone() == (False, 7, 4, "verbal_reported")


def test_birlestirme_satis_fiyati_sepet_ayri_tekrar_yok_wal_yok_eksik_silinmez(
    env: psycopg.Connection,
) -> None:
    run1 = _new_run(env)
    # Samba benzeri: satis 7.999, sepette 3.999,50 (kosullu), 38 beden.
    _add(env, run1, "813659620", 799900, basket=399950, variant_id="1084850373", variant_label="38")
    _add(env, run1, "857296094", 12499900, list_price=12799900, seller="724838")
    _add(env, run1, "5999429", 479940, page="listing_page", seller_name=None)
    with pytest.raises(psycopg.errors.UniqueViolation):
        _add(env, run1, "5999429", 479940)  # ayni kosuda ayni urun TEK satir
    _close(env, run1)
    first = _merge(run1)
    assert first.status == "success" and first.records == 3  # type: ignore[attr-defined]

    state = _offers(env)
    samba = state["813659620"]
    assert samba["price"] == 799900  # satis fiyati; sepet fiyati price DEGIL
    assert samba["attrs"]["basket_price"] == "3999.50"  # type: ignore[index]
    assert samba["attrs"]["variant_label"] == "38"  # type: ignore[index]
    assert samba["attrs"]["stock_state"] == "unknown" and samba["in_stock"] is False  # type: ignore[index]
    assert samba["seller"] == "106871" and samba["images"] == 2 and samba["points"] == 1
    assert samba["url"] == "https://www.trendyol.com/marka/test-urun-p-813659620"
    assert state["857296094"]["list"] == 12799900
    with env.cursor() as cur:
        cur.execute(
            "SELECT count(*) FROM price_point p JOIN offer o ON o.id = p.offer_id"
            " WHERE o.external_id = '813659620' AND p.price = 399950"
        )
        assert cur.fetchone() == (0,)  # sepet fiyati fiyat gecmisine GIRMEZ

    # 8 gun sonra ikinci kosu (kota): biri degismedi, biri fiyat degistirdi, biri HIC GELMEDI.
    _rewind(env, 8)
    run2 = _new_run(env)
    _add(env, run2, "813659620", 799900, basket=399950, variant_id="1084850373", variant_label="38")
    _add(env, run2, "857296094", 11999900, list_price=12799900, seller="724838")
    _close(env, run2)
    second = _merge(run2)
    assert second.status == "success"  # type: ignore[attr-defined]

    after = _offers(env)
    assert len(after) == 3  # tekrarlanan urun cogalmadi (offer = contentId)
    assert after["813659620"]["xmin"] == samba["xmin"]  # degismeyen satir YENIDEN YAZILMADI
    assert after["813659620"]["points"] == 1  # degismeyen fiyat: yeni nokta yok
    assert after["857296094"]["price"] == 11999900 and after["857296094"]["points"] == 2
    assert after["5999429"]["active"] is True  # eksik gelen urun PASIFLESMEZ
    with env.cursor() as cur:
        cur.execute(
            "SELECT count(*) FROM offer o JOIN merchant m ON m.id = o.merchant_id"
            " WHERE m.slug = 'trendyol' AND o.deactivated_at IS NOT NULL"
        )
        assert cur.fetchone() == (0,)


def test_ndjson_satiri_sepet_fiyatini_satis_fiyatindan_ayri_tasir() -> None:
    from datetime import UTC, datetime

    row = (
        1,
        "813659620",
        "T",
        "https://www.trendyol.com/m/t-p-813659620",
        799900,
        None,
        "TRY",
        None,
        "https://cdn.dsmcdn.com/a.jpg",
        "adidas",
        None,
        "106871",
        None,
        None,
        datetime.now(UTC),
        ["https://cdn.dsmcdn.com/a.jpg", "https://cdn.dsmcdn.com/b.jpg"],
        "SuperStep",
        "621971282",
        "1084850373",
        "38",
        399950,
    )
    record = to_feed_row(row)
    assert record["price"] == "7999.00"
    assert record["param"]["basket_price"] == "3999.50"
    assert record["param"]["seller_name"] == "SuperStep"
    assert record["images"] == ["https://cdn.dsmcdn.com/a.jpg", "https://cdn.dsmcdn.com/b.jpg"]
    assert "found_via" not in record["param"]  # kosudan kosuya degisen alan parmak izine girmez
    # Satis fiyatindan dusuk olmayan "sepet fiyati" tasinmaz.
    row2 = (*row[:20], 900000)
    assert "basket_price" not in to_feed_row(row2)["param"]
