"""Toplu urun siniflandirmasi (karar 0133): gercek PostgreSQL.

Kurulum SAHIP rolle; is UYGULAMA rolu baglantisiyla (uretimdeki gibi). Kosular test
magazasiyla sinirlidir (`merchant_slug`, kendi kontrol noktasi): baska urunlere dokunulmaz.
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import psycopg
import pytest

from classify import lexicon as lexicon_mod
from classify import run as run_mod
from classify.brands import brand_key
from classify.text import path_norm
from db.connection import database_url

pytestmark = pytest.mark.integration

SLUG = "test-cls-src"
HB_SLUG = "test-cls-hb"
ROOT = Path(__file__).resolve().parents[3]
TAXONOMY_SQL = ROOT / "packages" / "db" / "migrations" / "0089_category_taxonomy.sql"

PHONE_CASES = "Phones & Telecommunications > Mobile Phone Accessories > Phone Bags & Cases"
HEADPHONES = "Consumer Electronics > Portable Audio & Video > Earphones & Headphones"
SHOULDER = "Luggage & Bags > Women's Bags > Shoulder Bags"
WEAK = "Home & Garden > Others"

#: (anahtar, baslik, kaynak yolu, marka alani, yayin durumu, magaza)
PRODUCTS = (
    ("case", "Case for iPhone 16 Pro Max Shockproof", PHONE_CASES, None, "published", SLUG),
    ("buds", "Xiaomi Redmi Buds 5 Pro TWS Earbuds", HEADPHONES, None, "draft", SLUG),
    ("gaming", "RGB Gaming Headset 7.1 Surround", HEADPHONES, None, "draft", SLUG),
    ("bag", "Vintage Leather Bag Large", SHOULDER, None, "published", SLUG),
    ("vague", "Premium Quality Item 2024", PHONE_CASES, None, "draft", SLUG),
    ("review", "Original Gift Hot Sale", WEAK, None, "draft", SLUG),
    ("manual", "Moka Pot Espresso Maker", HEADPHONES, None, "published", SLUG),
    ("hb", "Kablosuz Kulaklık Bluetooth 5.3", "Kulaklık", "XIAOMI", "published", HB_SLUG),
    ("hbjunk", "Telefon Kılıfı Silikon", "Telefon Kılıfı", "Markasız", "draft", HB_SLUG),
)
#: Testin olusturabilecegi markalar (temizlikte yalniz baglanmamislari silinir).
TEST_BRANDS = ("Xiaomi", "Baseus", "Ugreen")


OFFERS_SQL = """SELECT id, product_id, current_price FROM offer
                WHERE merchant_id = ANY(%s) ORDER BY id"""


def _owner() -> psycopg.Connection:
    return psycopg.connect(database_url("DATABASE_URL_OWNER"))


def _app() -> psycopg.Connection:
    return psycopg.connect(database_url("DATABASE_URL"))


CLEANUP = (
    """DELETE FROM search_outbox WHERE entity = 'product' AND entity_id IN (
        SELECT id FROM product WHERE source_merchant_id IN
            (SELECT id FROM merchant WHERE slug = ANY(%(slugs)s)))""",
    """UPDATE offer SET product_id = NULL WHERE merchant_id IN
        (SELECT id FROM merchant WHERE slug = ANY(%(slugs)s))""",
    """DELETE FROM product WHERE source_merchant_id IN
        (SELECT id FROM merchant WHERE slug = ANY(%(slugs)s))""",
    """DELETE FROM category_source_map WHERE merchant_id IN
        (SELECT id FROM merchant WHERE slug = ANY(%(slugs)s))""",
    "DELETE FROM product_classification_state WHERE scope LIKE 'merchant:test-cls-%%'",
    "DELETE FROM offer WHERE merchant_id IN (SELECT id FROM merchant WHERE slug = ANY(%(slugs)s))",
    "DELETE FROM merchant WHERE slug = ANY(%(slugs)s)",
    "DELETE FROM brand WHERE slug = 'test-cls-xiaomi-caps'",
)


def _cleanup(cur: psycopg.Cursor) -> None:
    for statement in CLEANUP:
        cur.execute(statement, {"slugs": [SLUG, HB_SLUG]})


@pytest.fixture
def world() -> Iterator[dict[str, int]]:
    try:
        owner = _owner()
    except psycopg.OperationalError as error:  # pragma: no cover
        pytest.skip(f"yerel veritabani yok: {error}")
    with owner:
        with owner.cursor() as cur:
            _cleanup(cur)
            cur.execute("SELECT id FROM brand")
            brands_before = {int(r[0]) for r in cur.fetchall()}
            cur.execute("SELECT kind, surface FROM lexicon")
            lexicon_before = set(cur.fetchall())
            merchants: dict[str, int] = {}
            for slug, name in ((SLUG, "Test Cls Kaynak"), (HB_SLUG, "Test Cls HB")):
                cur.execute(
                    """INSERT INTO merchant (slug, name, domain, source_type, is_active)
                       VALUES (%s, %s, %s, 'xml_feed', TRUE) RETURNING id""",
                    (slug, name, f"{slug}.example"),
                )
                merchants[slug] = int(cur.fetchone()[0])  # type: ignore[index]
            # Ayni markanin buyuk harfli eski kaydi: siniflandirma ikinci "Xiaomi" acmamali.
            cur.execute(
                """INSERT INTO brand (slug, name, name_norm)
                   SELECT 'test-cls-xiaomi-caps', 'XIAOMI', 'xiaomi'
                    WHERE NOT EXISTS (SELECT 1 FROM brand WHERE name_norm = 'xiaomi')"""
            )
            cur.execute("SELECT id FROM category WHERE path = 'ev-yasam/mutfak'")
            mutfak = int(cur.fetchone()[0])  # type: ignore[index]
            cur.execute("SELECT min(id) FROM brand WHERE name_norm = 'xiaomi'")
            ids: dict[str, int] = {"mutfak": mutfak, "xiaomi_brand": int(cur.fetchone()[0])}  # type: ignore[index]
            for n, (key, title, source, brand_raw, state, slug) in enumerate(PRODUCTS):
                mid = merchants[slug]
                ext = f"{9_100_000_000 + n}"
                cur.execute(
                    """INSERT INTO offer (merchant_id, external_id, url, title_raw, brand_raw,
                                          category_raw, image_url, current_price, currency)
                       VALUES (%s, %s, %s, %s, %s, %s, %s, 1999, 'USD') RETURNING id""",
                    (
                        mid,
                        ext,
                        f"https://{slug}.example/item/{ext}",
                        title,
                        brand_raw,
                        source,
                        f"https://img.{slug}.example/{ext}.jpg",
                    ),
                )
                oid = int(cur.fetchone()[0])  # type: ignore[index]
                cur.execute(
                    """INSERT INTO product (slug, title, primary_image_url, source_merchant_id,
                                            source_external_id, source_offer_id,
                                            publication_state, published_at, min_price)
                       VALUES (%s, %s, %s, %s, %s, %s, %s,
                               CASE WHEN %s = 'published' THEN now() END, 5000)
                       RETURNING id""",
                    (
                        f"test-cls-{key}",
                        title,
                        f"https://img.{slug}.example/{ext}.jpg",
                        mid,
                        ext,
                        oid,
                        state,
                        state,
                    ),
                )
                pid = int(cur.fetchone()[0])  # type: ignore[index]
                if state == "published":
                    cur.execute("UPDATE offer SET product_id = %s WHERE id = %s", (pid, oid))
                ids[key] = pid
                ids[f"{key}_offer"] = oid
            # Elle (yonetici) girilmis kategori ve marka: korunmali.
            cur.execute(
                "UPDATE product SET category_id = %s, brand_id = %s WHERE id = %s",
                (mutfak, ids["xiaomi_brand"], ids["manual"]),
            )
        owner.commit()
        ids.update({f"merchant_{k}": v for k, v in merchants.items()})
        yield ids
        with owner.cursor() as cur:
            _cleanup(cur)
            cur.execute(
                """DELETE FROM brand b WHERE NOT (b.id = ANY(%s)) AND b.name = ANY(%s)
                     AND NOT EXISTS (SELECT 1 FROM product p WHERE p.brand_id = b.id)
                     AND NOT EXISTS (SELECT 1 FROM product_classification pc
                                      WHERE pc.brand_id = b.id)""",
                (list(brands_before), list(TEST_BRANDS)),
            )
            cur.execute("SELECT kind, surface FROM lexicon")
            for kind, surface in set(cur.fetchall()) - lexicon_before:
                cur.execute("DELETE FROM lexicon WHERE kind = %s AND surface = %s", (kind, surface))
        owner.commit()


def _run(**kwargs) -> run_mod.Counts:
    with _app() as conn:
        return run_mod.classify_products(conn, merchant_slug=kwargs.pop("slug", SLUG), **kwargs)


def _products(ids: dict[str, int]) -> dict[str, tuple]:
    keys = [k for k, *_ in PRODUCTS]
    with _owner() as conn, conn.cursor() as cur:
        cur.execute(
            """SELECT p.id, p.slug, p.title, p.primary_image_url, p.publication_state,
                      p.min_price, p.source_offer_id, p.public_id, b.name, c.path, p.updated_at
                 FROM product p LEFT JOIN brand b ON b.id = p.brand_id
                 LEFT JOIN category c ON c.id = p.category_id
                WHERE p.id = ANY(%s)""",
            ([ids[k] for k in keys],),
        )
        rows = {int(r[0]): r for r in cur.fetchall()}
    return {k: rows[ids[k]] for k in keys}


def _classification(pid: int) -> tuple | None:
    with _owner() as conn, conn.cursor() as cur:
        cur.execute(
            """SELECT state, brand_basis, category_basis, compatible_brands, wrote_brand,
                      wrote_category, detail, classified_at
                 FROM product_classification WHERE product_id = %s""",
            (pid,),
        )
        return cur.fetchone()


def test_fills_brand_and_category_and_preserves_everything_else(world: dict[str, int]) -> None:
    before = _products(world)
    with _owner() as conn, conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM product")
        product_count = int(cur.fetchone()[0])  # type: ignore[index]
        cur.execute("SELECT count(*) FROM brand WHERE name_norm = 'xiaomi'")
        xiaomi_brands = int(cur.fetchone()[0])  # type: ignore[index]
        cur.execute(
            OFFERS_SQL,
            ([world[f"merchant_{SLUG}"], world[f"merchant_{HB_SLUG}"]],),
        )
        offers_before = cur.fetchall()

    counts = _run()
    counts_hb = _run(slug=HB_SLUG)
    assert counts.completed and counts_hb.completed
    assert counts.errors == counts_hb.errors == 0

    after = _products(world)
    # Kimlik, slug, baslik, gorsel, yayin durumu, fiyat ozeti ve teklif bagi DEGISMEZ.
    for key in before:
        assert before[key][:8] == after[key][:8], key
    with _owner() as conn, conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM product")
        assert int(cur.fetchone()[0]) == product_count  # type: ignore[index]
        cur.execute(
            OFFERS_SQL,
            ([world[f"merchant_{SLUG}"], world[f"merchant_{HB_SLUG}"]],),
        )
        assert cur.fetchall() == offers_before
        cur.execute("SELECT count(*) FROM brand WHERE name_norm = 'xiaomi'")
        assert int(cur.fetchone()[0]) == xiaomi_brands  # type: ignore[index]

    assert after["case"][9] == "elektronik/telefon/aksesuar/kilif"
    assert after["case"][8] is None  # "for iPhone" uyumluluk; Apple markasi yazilmaz
    assert _classification(world["case"])[3] == ["Apple"]  # type: ignore[index]
    assert after["buds"][9] == "elektronik/ses/kulaklik/kablosuz"
    assert brand_key(after["buds"][8]) == "xiaomi"
    assert after["gaming"][9] == "elektronik/ses/kulaklik/oyuncu"
    assert after["bag"][9] == "moda/canta/omuz-cantasi"
    assert after["vague"][9] == "elektronik/telefon/aksesuar/kilif"
    # Zayif kanit: kategori yazilmaz, urun inceleme bekler (yayindan kalkmaz).
    assert after["review"][9] is None
    assert _classification(world["review"])[0] == "review"  # type: ignore[index]
    # Elle girilmis deger korunur.
    assert (after["manual"][8], after["manual"][9]) == (before["manual"][8], "ev-yasam/mutfak")
    assert _classification(world["manual"]) is None
    # Yapilandirilmis marka (HB): buyuk harfli "XIAOMI" mevcut Xiaomi'ye baglanir.
    assert brand_key(after["hb"][8]) == "xiaomi"
    assert after["hb"][9] == "elektronik/ses/kulaklik/kablosuz"
    assert after["hbjunk"][8] is None and after["hbjunk"][9] == "elektronik/telefon/aksesuar/kilif"

    with _owner() as conn, conn.cursor() as cur:
        cur.execute(
            """SELECT entity_id FROM search_outbox
                WHERE entity = 'product' AND reason = 'classified' AND entity_id = ANY(%s)""",
            ([world[k] for k, *_ in PRODUCTS],),
        )
        outbox = {int(r[0]) for r in cur.fetchall()}
        cur.execute(
            """SELECT path_norm, status, confidence FROM category_source_map
                WHERE merchant_id = %s ORDER BY path_norm""",
            (world[f"merchant_{SLUG}"],),
        )
        source_map = {r[0]: (r[1], r[2]) for r in cur.fetchall()}
    # Yalnizca yayindaki ve degisen urunler arama olayi uretir.
    assert outbox == {world["case"], world["bag"], world["hb"]}
    assert source_map[path_norm(PHONE_CASES)] == ("suggested", 90)
    assert source_map[path_norm(WEAK)][0] == "suggested"


def test_rerun_is_idempotent(world: dict[str, int]) -> None:
    _run()
    first = _products(world)
    stamp = _classification(world["case"])
    again = _run(rescan=True)
    assert again.completed
    assert again.brand_set == 0 and again.category_set == 0
    assert _products(world) == first  # updated_at dahil: hicbir satir yeniden yazilmadi
    assert _classification(world["case"]) == stamp


def test_resumes_after_interruption(world: dict[str, int]) -> None:
    partial = _run(batch_size=2, max_batches=1)
    assert not partial.completed and partial.scanned == 2
    with _owner() as conn, conn.cursor() as cur:
        cur.execute(
            """SELECT last_product_id, completed_at FROM product_classification_state
                WHERE scope = %s""",
            (f"merchant:{SLUG}",),
        )
        last, completed = cur.fetchone()  # type: ignore[misc]
    assert last == world["buds"] and completed is None
    rest = _run(batch_size=2)
    assert rest.completed
    assert partial.scanned + rest.scanned == sum(1 for p in PRODUCTS if p[5] == SLUG)
    after = _products(world)
    assert after["bag"][9] == "moda/canta/omuz-cantasi"
    assert after["case"][9] == "elektronik/telefon/aksesuar/kilif"


def test_rejected_source_map_reverts_only_own_writes(world: dict[str, int]) -> None:
    _run()
    assert _products(world)["vague"][9] == "elektronik/telefon/aksesuar/kilif"
    with _owner() as conn, conn.cursor() as cur:
        cur.execute(
            """UPDATE category_source_map SET status = 'rejected'
                WHERE merchant_id = %s AND path_norm = %s""",
            (world[f"merchant_{SLUG}"], path_norm(PHONE_CASES)),
        )
    _run(rescan=True)
    after = _products(world)
    # Basligi kategori gostermeyen urun kategorisiz kalir; basligi gosteren urun korunur.
    assert after["vague"][9] is None
    assert _classification(world["vague"])[0] == "review"  # type: ignore[index]
    assert after["case"][9] == "elektronik/telefon/aksesuar/kilif"
    assert after["manual"][9] == "ev-yasam/mutfak"


def test_confirmed_source_map_is_authoritative(world: dict[str, int]) -> None:
    with _owner() as conn, conn.cursor() as cur:
        cur.execute(
            """INSERT INTO category_source_map (merchant_id, source_path, path_norm, category_id,
                                                status)
               VALUES (%s, %s, %s, (SELECT min(id) FROM category WHERE path = 'moda/canta'),
                       'confirmed')""",
            (world[f"merchant_{SLUG}"], WEAK, path_norm(WEAK)),
        )
    _run()
    assert _products(world)["review"][9] == "moda/canta"
    with _owner() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT status FROM category_source_map WHERE merchant_id = %s AND path_norm = %s",
            (world[f"merchant_{SLUG}"], path_norm(WEAK)),
        )
        assert cur.fetchone()[0] == "confirmed"  # type: ignore[index]


def test_refuses_to_start_while_catalog_build_runs(world: dict[str, int]) -> None:
    busy = psycopg.connect(
        database_url("DATABASE_URL"), application_name="arilla-ingest:catalog_build"
    )
    try:
        with pytest.raises(run_mod.ClassifyAborted) as error:
            _run()
        assert error.value.code == "catalog_build_running"
        # Yalnizca okuyan olcum yine calisir ve hicbir sey yazmaz.
        report = _run(dry_run=True)
        assert report.category_set > 0
    finally:
        busy.close()
    assert all(row[9] is None for k, row in _products(world).items() if k != "manual")
    assert _classification(world["case"]) is None


def test_concurrent_change_is_never_overwritten(
    world: dict[str, int], monkeypatch: pytest.MonkeyPatch
) -> None:
    original = run_mod._read

    def read_then_admin_edits(conn, after, limit, merchant_id):
        rows = original(conn, after, limit, merchant_id)
        with _owner() as other, other.cursor() as cur:
            cur.execute(
                "UPDATE product SET category_id = %s WHERE id = %s", (world["mutfak"], world["bag"])
            )
        return rows

    monkeypatch.setattr(run_mod, "_read", read_then_admin_edits)
    counts = _run()
    assert counts.errors == 1
    assert _products(world)["bag"][9] == "ev-yasam/mutfak"
    state = _classification(world["bag"])
    assert state is not None and (state[0], state[6]) == ("error", "concurrent_change")


def test_taxonomy_migration_is_idempotent(world: dict[str, int]) -> None:
    with _owner() as conn, conn.cursor() as cur:
        cur.execute("SELECT count(*), max(id) FROM category")
        before = cur.fetchone()
        cur.execute(TAXONOMY_SQL.read_text(encoding="utf-8"))
        cur.execute("SELECT count(*), max(id) FROM category")
        assert cur.fetchone() == before
        conn.rollback()


def test_lexicon_apply_is_idempotent(world: dict[str, int]) -> None:
    with _app() as conn:
        first = lexicon_mod.apply(conn, write=True)
    with _app() as conn:
        second = lexicon_mod.apply(conn, write=True)
    assert not first.missing_paths
    assert second.inserted == 0
    assert second.existing >= first.inserted
    with _owner() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT normalized, weight FROM lexicon WHERE kind = 'category' AND surface = %s",
            ("kahve ekipmanları",),
        )
        assert cur.fetchone() == ("ev-yasam/mutfak/kahve-ekipmanlari", 3.0)


def test_wal_throttle_stops_before_writing_and_resumes(world: dict[str, int]) -> None:
    """Karar 0134: geri basinc partiden ONCE sorulur; False -> hicbir sey yazilmaz."""
    stopped = _run(throttle=lambda: False)
    assert stopped.stopped_reason == "wal" and not stopped.completed
    assert stopped.scanned == 0
    assert _classification(world["case"]) is None
    assert all(row[9] is None for k, row in _products(world).items() if k != "manual")

    calls: list[int] = []

    def allow() -> bool:
        calls.append(1)
        return True

    done = _run(throttle=allow)
    assert done.completed and done.stopped_reason is None
    assert len(calls) >= 1
    assert _products(world)["bag"][9] == "moda/canta/omuz-cantasi"


def test_lock_timeout_retries_batch_without_losing_or_corrupting_rows(
    world: dict[str, int], monkeypatch: pytest.MonkeyPatch
) -> None:
    original = run_mod._process_batch
    failures = {"left": 1}

    def flaky(conn, catalog, rows, *, dry_run):
        result = original(conn, catalog, rows, dry_run=dry_run)
        if failures["left"]:
            # Marka ve esleme satirlari bu islemde yazildiktan SONRA kilit hatasi: geri alinir.
            failures["left"] -= 1
            raise psycopg.errors.LockNotAvailable("simulated")
        return result

    monkeypatch.setattr(run_mod, "_process_batch", flaky)
    monkeypatch.setattr(run_mod, "LOCK_RETRY_SLEEP_SECONDS", 0.0)
    counts = _run()
    assert counts.completed and counts.errors == 0
    after = _products(world)
    assert brand_key(after["buds"][8]) == "xiaomi"
    assert after["case"][9] == "elektronik/telefon/aksesuar/kilif"


def test_persistent_lock_timeout_aborts_safely(
    world: dict[str, int], monkeypatch: pytest.MonkeyPatch
) -> None:
    def always_locked(conn, catalog, rows, *, dry_run):
        raise psycopg.errors.LockNotAvailable("simulated")

    monkeypatch.setattr(run_mod, "_process_batch", always_locked)
    monkeypatch.setattr(run_mod, "LOCK_RETRY_SLEEP_SECONDS", 0.0)
    with pytest.raises(run_mod.ClassifyAborted) as error:
        _run()
    assert error.value.code == "lock_timeout"
    with _owner() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT last_product_id FROM product_classification_state WHERE scope = %s",
            (f"merchant:{SLUG}",),
        )
        row = cur.fetchone()
    assert row is None or row[0] == 0


def test_real_wal_governor_is_bounded_and_keeps_checkpoint(world: dict[str, int]) -> None:
    """Gercek WalGovernor, birkac saniyelik sinirlarla: hicbir ortamda asili kalmaz.

    CI bu iste WAL arsivini acar (arsiv hatasi da sinanir); varsayilan politika orada 15 dk
    ile 1 sa arasi bekleyebilir. Sinirli politikayla is ya tamamlanir ya da 'wal' nedeniyle
    durur; ikisinde de kontrol noktasi tutarlidir. Arsiv kapaliysa (yerel) tamamlanmalidir.
    """
    import time as _time

    from db import wal_pressure

    policy = wal_pressure.WalPolicy(
        max_sleep_s=0.2, max_pause_s=2.0, failing_grace_s=2.0, poll_s=0.2, rate_window_s=2.0
    )
    started = _time.monotonic()
    with _app() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT current_setting('archive_mode')")
            archive_mode = str(cur.fetchone()[0])  # type: ignore[index]
        conn.rollback()
        gov = wal_pressure.WalGovernor.for_connection(conn, policy)
        counts = run_mod.classify_products(conn, merchant_slug=SLUG, throttle=gov.before_batch)
    assert _time.monotonic() - started < 60
    if archive_mode == "off":
        assert counts.completed and gov.stopped_reason is None
    else:
        assert counts.completed or counts.stopped_reason == "wal"
    with _owner() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT last_product_id FROM product_classification_state WHERE scope = %s",
            (f"merchant:{SLUG}",),
        )
        row = cur.fetchone()
    if counts.completed:
        assert row is not None and row[0] == counts.last_product_id
    else:
        assert row is None or row[0] == counts.last_product_id


def test_sample_is_read_only_and_matches_batch_decisions(world: dict[str, int]) -> None:
    with _owner() as conn, conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM product_classification")
        before = cur.fetchone()
    with _app() as conn:
        pairs = run_mod.sample_decisions(conn, n=50, merchant_slug=SLUG, seed=7)
    assert pairs and len({row.product_id for row, _ in pairs}) == len(pairs)
    by_id = {row.product_id: decision for row, decision in pairs}
    if world["bag"] in by_id:
        assert by_id[world["bag"]].category_path == "moda/canta/omuz-cantasi"
    with _owner() as conn, conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM product_classification")
        assert cur.fetchone() == before
        cur.execute(
            "SELECT count(*) FROM category_source_map WHERE merchant_id = %s",
            (world[f"merchant_{SLUG}"],),
        )
        assert cur.fetchone()[0] == 0  # type: ignore[index]
