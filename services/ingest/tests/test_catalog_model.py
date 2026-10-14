"""0065 katalog/besleme modelinin veritabani kisitlari (karar 0111).

Her test tek islemde calisir ve sonunda geri alinir: veritabaninda iz kalmaz.
"""

from __future__ import annotations

from collections.abc import Iterator

import psycopg
import pytest
from psycopg import errors

from db.connection import database_url

pytestmark = pytest.mark.integration


@pytest.fixture
def cur() -> Iterator[psycopg.Cursor]:
    try:
        conn = psycopg.connect(database_url("DATABASE_URL_OWNER"))
    except psycopg.OperationalError as error:  # pragma: no cover
        pytest.skip(f"yerel veritabani yok: {error}")
    try:
        with conn.cursor() as cursor:
            yield cursor
    finally:
        conn.rollback()
        conn.close()


def one(cur: psycopg.Cursor, sql: str, params: object = None) -> int:
    cur.execute(sql, params)
    row = cur.fetchone()
    assert row is not None
    return int(row[0])


def rejects(cur: psycopg.Cursor, error: type[Exception], sql: str, params: object = None) -> None:
    """Ifade hata vermeli; dis islem bozulmasin diye savepoint icinde."""
    assert cur.connection is not None
    with pytest.raises(error), cur.connection.transaction():
        cur.execute(sql, params)


def merchant(cur: psycopg.Cursor, slug: str) -> int:
    return one(
        cur,
        """INSERT INTO merchant (slug, name, domain, source_type)
           VALUES (%s, %s, %s, 'affiliate_network') RETURNING id""",
        (slug, slug, f"{slug}.test.invalid"),
    )


def product(cur: psycopg.Cursor, slug: str, brand_id: int | None = None) -> int:
    return one(
        cur,
        "INSERT INTO product (slug, title, brand_id) VALUES (%s, %s, %s) RETURNING id",
        (slug, slug, brand_id),
    )


def offer(cur: psycopg.Cursor, merchant_id: int, external_id: str, **cols: object) -> int:
    names = ["merchant_id", "external_id", "url", "title_raw", *cols]
    values = [
        merchant_id,
        external_id,
        f"https://x.invalid/{external_id}",
        external_id,
        *cols.values(),
    ]
    return one(
        cur,
        f"INSERT INTO offer ({', '.join(names)}) "
        f"VALUES ({', '.join(['%s'] * len(names))}) RETURNING id",
        values,
    )


def test_ayni_urunun_farkli_saticilari_ayri_teklif_ayni_kanonik_varyant(
    cur: psycopg.Cursor,
) -> None:
    ali = merchant(cur, "t0065-ali")
    s1 = one(
        cur,
        "INSERT INTO seller (merchant_id, external_id) VALUES (%s, 'store-1') RETURNING id",
        (ali,),
    )
    s2 = one(
        cur,
        "INSERT INTO seller (merchant_id, external_id) VALUES (%s, 'store-2') RETURNING id",
        (ali,),
    )
    p = product(cur, "t0065-telefon-siyah")
    v256 = one(
        cur,
        """INSERT INTO canonical_variant (product_id, option_key, options)
           VALUES (%s, 'kapasite=256gb', '{"kapasite":"256gb"}') RETURNING id""",
        (p,),
    )
    o1 = offer(cur, ali, "1005001", seller_id=s1, product_id=p)
    o2 = offer(cur, ali, "1005002", seller_id=s2, product_id=p)
    for o, sku in ((o1, "sku-a"), (o2, "sku-b")):
        cur.execute(
            """INSERT INTO offer_variant
                   (offer_id, external_id, canonical_variant_id, option_values)
               VALUES (%s, %s, %s, '{"kapasite":"256gb"}')""",
            (o, sku, v256),
        )
    cur.execute(
        """SELECT count(DISTINCT o.id), count(DISTINCT o.seller_id),
                  count(DISTINCT ov.canonical_variant_id)
             FROM offer o JOIN offer_variant ov ON ov.offer_id = o.id WHERE o.product_id = %s""",
        (p,),
    )
    assert cur.fetchone() == (2, 2, 1)
    # Ayni urunde ayni varyant anahtari ikinci kez olusamaz.
    rejects(
        cur,
        errors.UniqueViolation,
        "INSERT INTO canonical_variant (product_id, option_key) VALUES (%s, 'kapasite=256gb')",
        (p,),
    )


def test_kaynak_kimlikleri_ad_alanli(cur: psycopg.Cursor) -> None:
    a, b = merchant(cur, "t0065-a"), merchant(cur, "t0065-b")
    offer(cur, a, "42")
    offer(cur, b, "42")  # baska merchant'ta ayni kimlik serbest
    rejects(cur, errors.UniqueViolation, *_offer_sql(a, "42"))
    cur.execute("INSERT INTO seller (merchant_id, external_id) VALUES (%s, '7'), (%s, '7')", (a, b))
    rejects(
        cur,
        errors.UniqueViolation,
        "INSERT INTO seller (merchant_id, external_id) VALUES (%s, '7')",
        (a,),
    )
    cur.execute(
        "INSERT INTO feed_source (network, external_id)"
        " VALUES ('admitad', '1:main'), ('awin', '1:main')"
    )
    rejects(
        cur,
        errors.UniqueViolation,
        "INSERT INTO feed_source (network, external_id) VALUES ('admitad', '1:main')",
    )


def _offer_sql(merchant_id: int, external_id: str) -> tuple[str, tuple[object, ...]]:
    return (
        "INSERT INTO offer (merchant_id, external_id, url, title_raw)"
        " VALUES (%s, %s, 'https://x.invalid', 't')",
        (merchant_id, external_id),
    )


def test_gtin_kimligi_tek_aktif_hedef_celiskide_ikinci_kayit(cur: psycopg.Cursor) -> None:
    p = product(cur, "t0065-gtin")
    v = one(
        cur,
        "INSERT INTO canonical_variant (product_id, option_key) VALUES (%s, '') RETURNING id",
        (p,),
    )
    gtin = "08691234567891"
    cur.execute(
        """INSERT INTO product_identity (kind, value_norm, target_level, canonical_variant_id)
           VALUES ('gtin', %s, 'variant', %s)""",
        (gtin, v),
    )
    rejects(
        cur,
        errors.UniqueViolation,
        """INSERT INTO product_identity (kind, value_norm, target_level, canonical_variant_id)
           VALUES ('gtin', %s, 'variant', %s)""",
        (gtin, v),
    )
    # Celiskili isaretlenen kayit ayni degeri tasiyabilir (aktif degil).
    cur.execute(
        """INSERT INTO product_identity
               (kind, value_norm, target_level, canonical_variant_id, status)
           VALUES ('gtin', %s, 'variant', %s, 'conflict')""",
        (gtin, v),
    )
    # GTIN urun duzeyini hedefleyemez; 14 hane zorunlu.
    rejects(
        cur,
        errors.CheckViolation,
        "INSERT INTO product_identity (kind, value_norm, target_level, product_id)"
        " VALUES ('gtin', %s, 'product', %s)",
        (gtin, p),
    )
    rejects(
        cur,
        errors.CheckViolation,
        """INSERT INTO product_identity (kind, value_norm, target_level, canonical_variant_id)
           VALUES ('gtin', '8691234567891', 'variant', %s)""",
        (v,),
    )


def test_mpn_marka_ister_model_ipucu_benzersiz_degil(cur: psycopg.Cursor) -> None:
    brand = one(
        cur, "INSERT INTO brand (slug, name, name_norm) VALUES ('t0065-b', 'B', 'b') RETURNING id"
    )
    p1, p2 = product(cur, "t0065-m1", brand), product(cur, "t0065-m2", brand)
    rejects(
        cur,
        errors.CheckViolation,
        "INSERT INTO product_identity (kind, value_norm, target_level, product_id)"
        " VALUES ('mpn', 'X1', 'product', %s)",
        (p1,),
    )
    sql = """INSERT INTO product_identity (kind, value_norm, brand_id, target_level, product_id)
             VALUES ('mpn', 'SMA556B', %s, 'product', %s)"""
    cur.execute(sql, (brand, p1))
    rejects(cur, errors.UniqueViolation, sql, (brand, p2))
    for target in (p1, p2):
        cur.execute(
            """INSERT INTO product_identity (kind, value_norm, target_level, product_id)
               VALUES ('model_hint', 'galaxy-a55', 'product', %s)""",
            (target,),
        )


def test_besleme_durumu_ve_surum_kisitlari(cur: psycopg.Cursor) -> None:
    m = merchant(cur, "t0065-feed")
    # Merchant'a baglanmadan etkinlestirilemez.
    rejects(
        cur,
        errors.CheckViolation,
        "INSERT INTO feed_source (network, external_id, status)"
        " VALUES ('admitad', 'x:1', 'active')",
    )
    fs = one(
        cur,
        """INSERT INTO feed_source (network, external_id, merchant_id, status)
           VALUES ('admitad', 'x:2', %s, 'active') RETURNING id""",
        (m,),
    )
    sha = "a" * 64
    cur.execute(
        "INSERT INTO source_snapshot (feed_source_id, status, sha256) VALUES (%s, 'complete', %s)",
        (fs, sha),
    )
    # Ayni icerik ikinci kez tamamlanamaz; tekrar indirme 'duplicate' olarak kaydedilir.
    rejects(
        cur,
        errors.UniqueViolation,
        "INSERT INTO source_snapshot (feed_source_id, status, sha256) VALUES (%s, 'complete', %s)",
        (fs, sha),
    )
    cur.execute(
        "INSERT INTO source_snapshot (feed_source_id, status, sha256) VALUES (%s, 'duplicate', %s)",
        (fs, sha),
    )
    rejects(
        cur,
        errors.CheckViolation,
        "INSERT INTO source_snapshot (feed_source_id, sha256) VALUES (%s, 'not-a-hash')",
        (fs,),
    )


def test_deaktivasyon_nedeni_ve_hata_kaydi_sinirli(cur: psycopg.Cursor) -> None:
    m = merchant(cur, "t0065-deact")
    o = offer(cur, m, "1")
    cur.execute(
        """UPDATE offer SET is_active = false, deactivated_at = now(),
                          deactivation_reason = 'missing_from_snapshot' WHERE id = %s""",
        (o,),
    )
    rejects(
        cur,
        errors.CheckViolation,
        "UPDATE offer SET deactivation_reason = 'whim' WHERE id = %s",
        (o,),
    )
    rejects(
        cur,
        errors.CheckViolation,
        "INSERT INTO ingest_error (error_code, detail) VALUES ('Bad Code', 'x')",
    )
    rejects(
        cur,
        errors.CheckViolation,
        "INSERT INTO ingest_error (error_code, payload) VALUES ('too_big', %s::jsonb)",
        ('{"x":"' + "y" * 20000 + '"}',),
    )


def test_eslestirme_karari_bagda_urun_ister(cur: psycopg.Cursor) -> None:
    m = merchant(cur, "t0065-match")
    o = offer(cur, m, "1")
    rejects(
        cur,
        errors.CheckViolation,
        "INSERT INTO match_decision_log (offer_id, decision, actor, basis)"
        " VALUES (%s, 'link', 'resolver', 'gtin')",
        (o,),
    )
    cur.execute(
        "INSERT INTO match_decision_log (offer_id, decision, actor, basis)"
        " VALUES (%s, 'hold', 'resolver', 'gtin_variant_mismatch')",
        (o,),
    )
