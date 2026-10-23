"""Trend eslestirme isi - gercek yerel Postgres (kuru kosu, yazim, idempotans, esik temizligi,
elle secilmis trendlerin korunmasi)."""

from __future__ import annotations

import threading
import time
from collections.abc import Iterator

import psycopg
import pytest

import curate.trends as trends_mod
from curate.selection import MIN_PUBLIC_PRODUCTS, Profile
from curate.trends import is_local_url, run
from db.connection import database_url

pytestmark = pytest.mark.integration

SLUG = "test-curate-trend"
SLUG_FEW = "test-curate-few"
#: Profili SLUG ile ayni: otomatik olsaydi 6 urunle yeniden yazilirdi.
SLUG_MANUAL = "test-curate-manual"
PREFIX = "test-curate"
PROFILES = {
    SLUG: Profile(SLUG, core=("kurasyon kazak",), categories=()),
    SLUG_FEW: Profile(SLUG_FEW, core=("kurasyon esarp",), categories=()),
    SLUG_MANUAL: Profile(SLUG_MANUAL, core=("kurasyon kazak",), categories=()),
}
#: Editorun elle sectigi baglar (sirasiyla).
MANUAL_PICKS = [f"{PREFIX}-p5", f"{PREFIX}-p3"]


@pytest.fixture
def conn(monkeypatch: pytest.MonkeyPatch) -> Iterator[psycopg.Connection]:
    try:
        connection = psycopg.connect(database_url("DATABASE_URL_OWNER"))
    except psycopg.OperationalError as error:  # pragma: no cover
        pytest.skip(f"yerel veritabani yok: {error}")

    def clean() -> None:
        connection.rollback()
        with connection.cursor() as cur:
            cur.execute("DELETE FROM trend WHERE slug LIKE %s", (f"{PREFIX}%",))
            cur.execute(
                "DELETE FROM offer WHERE merchant_id IN (SELECT id FROM merchant WHERE slug = %s)",
                (f"{PREFIX}-m",),
            )
            cur.execute("DELETE FROM product WHERE slug LIKE %s", (f"{PREFIX}%",))
            cur.execute("DELETE FROM merchant WHERE slug = %s", (f"{PREFIX}-m",))
        connection.commit()

    try:
        to_skip = False
        with connection.cursor() as cur:
            cur.execute("SELECT to_regclass('trend') IS NULL")
            to_skip = bool(cur.fetchone()[0])
        if to_skip:
            pytest.skip("trend tablosu yok (0056 uygulanmamis)")
        clean()
        with connection.cursor() as cur:
            cur.execute(
                "INSERT INTO merchant (slug, name, domain, source_type) "
                "VALUES (%s, 'Test', 'test-curate.example', 'user_discovered') RETURNING id",
                (f"{PREFIX}-m",),
            )
            merchant_id = cur.fetchone()[0]
            for i in range(6):
                cur.execute(
                    "INSERT INTO product "
                    "(slug, title, primary_image_url, min_price, in_stock_count, offer_count) "
                    "VALUES (%s, %s, %s, %s, 1, 1) RETURNING id",
                    (
                        f"{PREFIX}-p{i}",
                        f"Kurasyon Kazak model{chr(97 + i)} desen{i}" + (" Yün" if i == 0 else ""),
                        f"https://img.test.example/{i}.jpg",
                        10_000 + i,
                    ),
                )
                product_id = cur.fetchone()[0]
                cur.execute(
                    "INSERT INTO offer "
                    "(merchant_id, product_id, external_id, url, title_raw, current_price) "
                    "VALUES (%s, %s, %s, 'https://test-curate.example/x', 't', %s)",
                    (merchant_id, product_id, f"ext{i}", 10_000 + i),
                )
            # Stokta olmayan ve gorselsiz urun aday olmaz.
            cur.execute(
                "INSERT INTO product (slug, title, primary_image_url, min_price, in_stock_count) "
                "VALUES (%s, 'Kurasyon Kazak stoksuz', 'https://img.test.example/s.jpg', 100, 0)",
                (f"{PREFIX}-sold-out",),
            )
            cur.execute(
                "INSERT INTO trend (slug, title, description, category, status) VALUES "
                "(%s, 'Test', 'Test.', 'moda', 'published'), "
                "(%s, 'Az', 'Az.', 'moda', 'published')",
                (SLUG, SLUG_FEW),
            )
            # Az urunlu trendin eski baglari temizlenmeli.
            cur.execute(
                "INSERT INTO trend_product (trend_id, product_id, sort_order) "
                "SELECT t.id, p.id, 0 FROM trend t, product p WHERE t.slug = %s AND p.slug = %s",
                (SLUG_FEW, f"{PREFIX}-p1"),
            )
            cur.execute(
                "INSERT INTO trend (slug, title, description, category, status, curation) "
                "VALUES (%s, 'Elle', 'Elle.', 'moda', 'published', 'manual')",
                (SLUG_MANUAL,),
            )
            for order, product_slug in enumerate(MANUAL_PICKS):
                add_link(cur, SLUG_MANUAL, product_slug, order)
        connection.commit()
        monkeypatch.setattr(trends_mod, "BY_SLUG", PROFILES)
        yield connection
    finally:
        clean()
        connection.close()


def add_link(cur: psycopg.Cursor, trend_slug: str, product_slug: str, order: int) -> None:
    cur.execute(
        "INSERT INTO trend_product (trend_id, product_id, sort_order) "
        "SELECT t.id, p.id, %s FROM trend t, product p WHERE t.slug = %s AND p.slug = %s",
        (order, trend_slug, product_slug),
    )


def set_curation(cur: psycopg.Cursor, slug: str, curation: str) -> None:
    cur.execute("UPDATE trend SET curation = %s WHERE slug = %s", (curation, slug))


def links(conn: psycopg.Connection, slug: str) -> list[str]:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT p.slug FROM trend_product tp JOIN trend t ON t.id = tp.trend_id "
            "JOIN product p ON p.id = tp.product_id WHERE t.slug = %s ORDER BY tp.sort_order",
            (slug,),
        )
        return [row[0] for row in cur.fetchall()]


def test_dry_run_writes_nothing(conn: psycopg.Connection):
    results = run(conn, apply=False, slugs=[SLUG])
    assert results[0].count == 6
    assert links(conn, SLUG) == []


def test_apply_orders_by_score_excludes_unfit_and_is_idempotent(conn: psycopg.Connection):
    run(conn, apply=True, slugs=[SLUG])
    first = links(conn, SLUG)
    assert len(first) == 6
    assert first[0] == f"{PREFIX}-p0"  # "Yun" boost'u olan en iyi eslesme
    assert f"{PREFIX}-sold-out" not in first
    run(conn, apply=True, slugs=[SLUG])
    assert links(conn, SLUG) == first


def test_below_threshold_clears_stale_links(conn: psycopg.Connection):
    assert links(conn, SLUG_FEW) == [f"{PREFIX}-p1"]
    results = run(conn, apply=True, slugs=[SLUG_FEW])
    assert results[0].count == 0
    assert links(conn, SLUG_FEW) == []
    assert MIN_PUBLIC_PRODUCTS == 4


def test_is_local_url():
    assert is_local_url("postgresql://u:p@localhost:5432/db")
    assert is_local_url("postgresql://u:p@127.0.0.1/db")
    assert not is_local_url("postgresql://u:p@aws-1-eu-west-1.pooler.supabase.com:5432/postgres")
    assert not is_local_url("not a url")


def test_dry_run_is_server_side_read_only(conn: psycopg.Connection, monkeypatch):
    """Kuru kosuda yazim yolu cagrilirsa test patlar; baglanti READ ONLY'dir."""

    def boom(*_args, **_kwargs):
        raise AssertionError("kuru kosu yazim yoluna girdi")

    monkeypatch.setattr(trends_mod, "write_trend", boom)
    seen: list[bool] = []
    real = trends_mod.curate_trend

    def spy(c, slug, title):
        with c.cursor() as cur:
            cur.execute("SHOW transaction_read_only")
            seen.append(cur.fetchone()[0] == "on")
            with pytest.raises(psycopg.errors.ReadOnlySqlTransaction):
                cur.execute("DELETE FROM trend_product")
            c.rollback()
            c.read_only = True
        return real(c, slug, title)

    monkeypatch.setattr(trends_mod, "curate_trend", spy)
    run(conn, apply=False, slugs=[SLUG])
    assert seen == [True]
    assert links(conn, SLUG) == []


def test_manual_trend_is_not_loaded_even_when_requested(conn: psycopg.Connection):
    results = run(conn, apply=False, slugs=[SLUG, SLUG_MANUAL])
    assert [r.slug for r in results] == [SLUG]
    assert links(conn, SLUG_MANUAL) == MANUAL_PICKS


def test_apply_keeps_manual_links_across_repeated_runs(conn: psycopg.Connection):
    """Ayni profilli otomatik trend yeniden yazilir; elle secilmis trend iki kosuda da aynen
    kalir."""
    for _ in range(2):
        run(conn, apply=True, slugs=[SLUG, SLUG_MANUAL])
        assert len(links(conn, SLUG)) == 6
        assert links(conn, SLUG_MANUAL) == MANUAL_PICKS


def test_switch_to_manual_after_load_is_respected(conn: psycopg.Connection, monkeypatch):
    """Kosu trendi `auto` iken yukledi; yazimdan once baska bir islem onu `manual`a cevirip
    kendi secimini COMMIT etti. Yazim yolu kilitle yeniden okur ve dokunmaz."""
    real_load = trends_mod.load_trends

    def load_then_editor_commits(c, slugs):
        loaded = real_load(c, slugs)
        with psycopg.connect(database_url("DATABASE_URL_OWNER")) as editor, editor.cursor() as cur:
            set_curation(cur, SLUG, "manual")
            add_link(cur, SLUG, f"{PREFIX}-p4", 0)
        return loaded

    monkeypatch.setattr(trends_mod, "load_trends", load_then_editor_commits)
    results = run(conn, apply=True, slugs=[SLUG])
    assert results[0].note == "manuel: atlandi"
    assert links(conn, SLUG) == [f"{PREFIX}-p4"]


def test_apply_waits_for_concurrent_switch_to_manual(conn: psycopg.Connection):
    """Editor islemi trendi `manual`a cevirmis ama henuz COMMIT etmemisken kosu baslar:
    yazim yolu satir kilidinde bekler, COMMIT'ten sonra `manual` gorur ve atlar."""
    editor = psycopg.connect(database_url("DATABASE_URL_OWNER"))
    try:
        with editor.cursor() as cur:
            set_curation(cur, SLUG, "manual")  # kilit editorde, COMMIT yok
        outcome: dict[str, object] = {}

        def apply_run() -> None:
            try:
                outcome["results"] = run(conn, apply=True, slugs=[SLUG])
            except BaseException as error:  # pragma: no cover - teshis icin
                outcome["error"] = error

        worker = threading.Thread(target=apply_run)
        worker.start()
        with psycopg.connect(database_url("DATABASE_URL_OWNER"), autocommit=True) as watcher:
            deadline = time.monotonic() + 10
            waiting = False
            while time.monotonic() < deadline and not waiting:
                waiting = bool(
                    watcher.execute(
                        "SELECT count(*) FROM pg_stat_activity WHERE wait_event_type = 'Lock' "
                        "AND query LIKE 'SELECT curation FROM trend%%FOR UPDATE'"
                    ).fetchone()[0]
                )
                time.sleep(0.05)
        assert waiting, "curate yazimi editor kilidini beklemedi"
        with editor.cursor() as cur:
            add_link(cur, SLUG, f"{PREFIX}-p2", 0)
        editor.commit()
        worker.join(timeout=10)
        assert not worker.is_alive()
        assert "error" not in outcome
        assert outcome["results"][0].note == "manuel: atlandi"
        assert links(conn, SLUG) == [f"{PREFIX}-p2"]
    finally:
        editor.rollback()
        editor.close()


def test_below_threshold_never_clears_manual_links(conn: psycopg.Connection, monkeypatch):
    """Esik temizligi (silme yolu) yalniz otomatik trende uygulanir: profili hic urun bulmayan
    elle secilmis trendin baglari kalir."""
    profile = Profile(SLUG_MANUAL, core=("kurasyon esarp",), categories=())
    monkeypatch.setitem(trends_mod.BY_SLUG, SLUG_MANUAL, profile)
    results = run(conn, apply=True, slugs=[SLUG_FEW, SLUG_MANUAL])
    assert [r.slug for r in results] == [SLUG_FEW]
    assert links(conn, SLUG_FEW) == []
    assert links(conn, SLUG_MANUAL) == MANUAL_PICKS


def test_switch_back_to_auto_is_curated_again(conn: psycopg.Connection):
    """`auto`ya geri alinan trend yeniden kurator isine girer; elle secim yerini otomatik
    eslesmeye birakir."""
    with conn.cursor() as cur:
        set_curation(cur, SLUG_MANUAL, "auto")
    conn.commit()
    run(conn, apply=True, slugs=[SLUG_MANUAL])
    assert len(links(conn, SLUG_MANUAL)) == 6


def test_trend_deleted_after_load_is_skipped(conn: psycopg.Connection, monkeypatch):
    """Kosu trendi yukledikten sonra baska bir islem trendi sildi: yazim yolu satiri bulamaz,
    hata vermeden atlar ve sahipsiz bag yazmaz."""
    real_load = trends_mod.load_trends

    def load_then_delete(c, slugs):
        loaded = real_load(c, slugs)
        with psycopg.connect(database_url("DATABASE_URL_OWNER")) as other, other.cursor() as cur:
            cur.execute("DELETE FROM trend WHERE slug = %s", (SLUG,))
        return loaded

    monkeypatch.setattr(trends_mod, "load_trends", load_then_delete)
    run(conn, apply=True, slugs=[SLUG])
    with conn.cursor() as cur:
        cur.execute(
            "SELECT count(*) FROM trend_product tp JOIN product p ON p.id = tp.product_id "
            "WHERE p.slug LIKE %s AND NOT EXISTS (SELECT 1 FROM trend t WHERE t.id = tp.trend_id)",
            (f"{PREFIX}%",),
        )
        assert cur.fetchone()[0] == 0
    assert links(conn, SLUG_MANUAL) == MANUAL_PICKS
