"""Sitemap kesif defteri toplu isleri (karar 0120): yayinlama, fiyat baglama, kaldirma.

Sentetik kayitlar; gercek Hepsiburada verisi ya da istegi YOK.
"""

from __future__ import annotations

import json
from collections.abc import Iterator

import psycopg
import pytest

from feeds.discovery_catalog import finalize, link_prices, publish, recount
from feeds.intake import merge_run
from tests.test_hb_intake import _add, _cleanup, _close, _new_run, _owner

pytestmark = pytest.mark.integration

INSERT_GUARD = "catalog_sync_operation_insert_guard_trg"


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
        cur.execute(
            "UPDATE discovery_source_policy SET enabled = TRUE WHERE source = 'hepsiburada'"
        )
        cur.execute("UPDATE catalog_discovery_tally SET items_total = 0, items_priced = 0")
    try:
        yield owner
    finally:
        with owner.cursor() as cur:
            _cleanup(cur)
            cur.execute(
                "UPDATE discovery_source_policy SET enabled = FALSE WHERE source = 'hepsiburada'"
            )
        owner.close()


def _operation(
    owner: psycopg.Connection,
    *,
    kind: str = "initial_import",
    status: str = "completed",
    complete: bool = True,
    files: int = 10,
) -> int:
    """Tetikleyiciler kapatilarak dogrudan yazilan operasyon (yasam dongusu TS testlerinde)."""
    with owner.cursor() as cur:
        run_id = None
        if kind == "weekly_refresh":
            cur.execute("ALTER TABLE collection_run DISABLE TRIGGER collection_run_quota_guard_trg")
            cur.execute(
                """INSERT INTO collection_run (source, kind, status, expires_at, closed_at,
                                               max_requests)
                   VALUES ('hepsiburada', 'refresh', 'completed', now(), now(), 500)
                   RETURNING id"""
            )
            run_id = cur.fetchone()[0]  # type: ignore[index]
            cur.execute("ALTER TABLE collection_run ENABLE TRIGGER collection_run_quota_guard_trg")
        cur.execute(f"ALTER TABLE catalog_sync_operation DISABLE TRIGGER {INSERT_GUARD}")
        cur.execute(
            """INSERT INTO catalog_sync_operation
                   (source, kind, status, quota_run_id, network_declared, max_requests, max_bytes,
                    files_planned, closed_at, removal_state, summary)
               VALUES ('hepsiburada', %s, %s, %s, 'wifi', 8000, 1000000, %s, now(), %s, %s::jsonb)
               RETURNING id""",
            (
                kind,
                status,
                run_id,
                files,
                "pending" if kind == "weekly_refresh" else "not_applicable",
                json.dumps({"complete": complete, "filesFailed": 0 if complete else 1}),
            ),
        )
        op_id = cur.fetchone()[0]  # type: ignore[index]
        cur.execute(f"ALTER TABLE catalog_sync_operation ENABLE TRIGGER {INSERT_GUARD}")
    return int(op_id)


def _item(
    owner: psycopg.Connection,
    code: str,
    op_id: int,
    *,
    title: str | None = "Test ürün başlığı uzun",
    image: str | None = "https://productimages.hepsiburada.net/s/1/a.jpg",
) -> None:
    with owner.cursor() as cur:
        cur.execute(
            """INSERT INTO catalog_discovery
                   (source, external_id, code_kind, url_path, title, image_url,
                    first_seen_operation_id, last_seen_operation_id, last_seen_unit_seq)
               VALUES ('hepsiburada', %s, 'p', %s, %s, %s, %s, %s, 1)""",
            (code, f"/test-urun-p-{code}", title, image, op_id, op_id),
        )


def _seen(owner: psycopg.Connection, code: str, op_id: int) -> None:
    with owner.cursor() as cur:
        cur.execute(
            """UPDATE catalog_discovery SET last_seen_operation_id = %s, missed_scans = 0,
                      presence = 'present', last_seen_at = now()
                WHERE external_id = %s""",
            (op_id, code),
        )


def _row(owner: psycopg.Connection, code: str) -> dict:
    with owner.cursor(row_factory=psycopg.rows.dict_row) as cur:
        cur.execute("SELECT * FROM catalog_discovery WHERE external_id = %s", (code,))
        row = cur.fetchone()
    assert row
    return row


def _app() -> psycopg.Connection:
    from db.connection import database_url

    return psycopg.connect(database_url("DATABASE_URL"))


def test_yayinlama_fiyatsiz_teklif_acar_ve_tekrarlanabilir(env: psycopg.Connection) -> None:
    op = _operation(env)
    _item(env, "HBCV0000AA01", op)
    _item(env, "HBCV0000AA02", op, title="Kısa")  # kisa baslik: yayinlanmaz
    _item(env, "HBCV0000AA03", op, image=None)  # gorselsiz: yayinlanmaz
    _item(env, "HBCV0000AA04", op)
    # Ayni kodlu teklif zaten var (or. dogrulanmis toplama): yeni teklif ACILMAZ, baglanir.
    with env.cursor() as cur:
        cur.execute(
            """INSERT INTO offer (merchant_id, external_id, url, title_raw, current_price)
               SELECT id, 'HBCV0000AA04', 'https://www.hepsiburada.com/x-p-HBCV0000AA04',
                      'Mevcut', 12345 FROM merchant WHERE slug = 'hepsiburada'"""
        )
    with _app() as conn:
        dry = publish(conn, "hepsiburada", limit=100, dry_run=True)
        assert (dry.considered, dry.created) == (2, 0)
        report = publish(conn, "hepsiburada", limit=100)
        assert (report.created, report.linked_existing) == (1, 1)
        again = publish(conn, "hepsiburada", limit=100)
        assert (again.considered, again.created) == (0, 0)
    with env.cursor() as cur:
        cur.execute(
            """SELECT external_id, current_price, in_stock, is_active, attributes_raw, url
                 FROM offer WHERE external_id LIKE 'HBCV0000AA0%' ORDER BY external_id"""
        )
        offers = cur.fetchall()
        cur.execute("SELECT count(*) FROM search_outbox WHERE reason = 'discovery_publish'")
        outbox = cur.fetchone()[0]  # type: ignore[index]
    assert [o[0] for o in offers] == ["HBCV0000AA01", "HBCV0000AA04"]
    # Fiyat UYDURULMAZ: yeni teklif fiyatsiz, stok bilinmiyor; mevcut fiyat degismez.
    assert offers[0][1] is None and offers[0][3] is True
    assert offers[0][4]["price_state"] == "unpriced" and offers[0][4]["stock_state"] == "unknown"
    assert offers[0][5] == "https://www.hepsiburada.com/test-urun-p-HBCV0000AA01"
    assert offers[1][1] == 12345
    assert outbox == 1
    assert _row(env, "HBCV0000AA01")["publish_state"] == "published"
    assert _row(env, "HBCV0000AA02")["publish_state"] == "hidden"


def test_fiyat_yalnizca_ayni_kodla_baglanir(env: psycopg.Connection) -> None:
    op = _operation(env)
    _item(env, "HBCV0000BB01", op)
    _item(env, "HBCV0000BB02", op, title="Test urun HBCV0000BB99")  # ayni ad, farkli kod
    run = _new_run(env)
    _add(env, run, "HBCV0000BB01", 49_999_00)
    _add(env, run, "HBCV0000BB99", 10_000_00)
    _close(env, run)
    with _app() as conn:
        report = merge_run(conn, run)
    assert report.status == "success"
    assert report.discovery_linked == 1
    linked = _row(env, "HBCV0000BB01")
    assert linked["price_state"] == "verified"
    assert linked["price_offer_id"] is not None
    assert linked["price_source"] == "hb_collection"
    other = _row(env, "HBCV0000BB02")
    assert other["price_state"] == "unpriced" and other["price_offer_id"] is None
    with env.cursor() as cur:
        cur.execute("SELECT items_total, items_priced FROM catalog_discovery_tally")
        assert cur.fetchone() == (2, 1)
    # Ayni kayit ikinci kez baglanmaz (daha yeni gozlem yok).
    with _app() as conn:
        assert link_prices(conn, run) == 0


def test_kaldirma_yalnizca_ardisik_tam_taramalarda(env: psycopg.Connection) -> None:
    initial = _operation(env)
    for code in ("HBCV0000CC01", "HBCV0000CC02", "HBCV0000CC03"):
        _item(env, code, initial)
    with _app() as conn:
        publish(conn, "hepsiburada", limit=10)

    # Yarim tarama: hicbir urun etkilenmez.
    partial = _operation(env, kind="weekly_refresh", complete=False)
    _seen(env, "HBCV0000CC01", partial)
    with _app() as conn:
        r = finalize(conn, partial)
    assert (r.status, r.reason) == ("skipped_partial", "incomplete_scan")
    assert _row(env, "HBCV0000CC02")["presence"] == "present"

    # Indeks beklenmedik kucuk: degerlendirme yok.
    shrunk = _operation(env, kind="weekly_refresh", files=5)
    with _app() as conn:
        assert finalize(conn, shrunk).reason == "index_shrank"
    assert _row(env, "HBCV0000CC02")["missed_scans"] == 0

    # Birinci tam tarama: CC02 gorulmedi -> missing (henuz kaldirilmadi).
    first = _operation(env, kind="weekly_refresh")
    _seen(env, "HBCV0000CC01", first)
    _seen(env, "HBCV0000CC03", first)
    with _app() as conn:
        r1 = finalize(conn, first)
        assert finalize(conn, first).reason == "not_pending"  # bir kez
    assert (r1.status, r1.missing, r1.removed) == ("done", 1, 0)
    row = _row(env, "HBCV0000CC02")
    assert (row["presence"], row["missed_scans"]) == ("missing", 1)

    # Ikinci tam tarama: CC02 yine yok -> removed; fiyatsiz teklifi pasiflesir, satir SILINMEZ.
    second = _operation(env, kind="weekly_refresh")
    _seen(env, "HBCV0000CC01", second)
    _seen(env, "HBCV0000CC03", second)
    with _app() as conn:
        r2 = finalize(conn, second)
    assert (r2.removed, r2.withdrawn) == (1, 1)
    row = _row(env, "HBCV0000CC02")
    assert (row["presence"], row["publish_state"]) == ("removed", "withdrawn")
    with env.cursor() as cur:
        cur.execute(
            "SELECT is_active, deactivation_reason FROM offer WHERE id = %s", (row["offer_id"],)
        )
        assert cur.fetchone() == (False, "source_removed")
        cur.execute("SELECT removal_state FROM catalog_sync_operation WHERE id = %s", (second,))
        assert cur.fetchone() == ("done",)
    assert _row(env, "HBCV0000CC01")["presence"] == "present"
    with _app() as conn:
        counts = recount(conn, "hepsiburada")
    assert counts == {"total": 3, "priced": 0, "published": 2, "removed": 1}


def test_bayat_fiyat_guncel_gosterilmez(env: psycopg.Connection) -> None:
    op = _operation(env)
    _item(env, "HBCV0000DD01", op)
    with env.cursor() as cur:
        cur.execute(
            """INSERT INTO offer (merchant_id, external_id, url, title_raw, current_price)
               SELECT id, 'HBCV0000DD01', 'https://www.hepsiburada.com/x-p-HBCV0000DD01', 'x', 100
                 FROM merchant WHERE slug = 'hepsiburada' RETURNING id"""
        )
        offer_id = cur.fetchone()[0]  # type: ignore[index]
        cur.execute(
            """UPDATE catalog_discovery SET price_state = 'verified', price_offer_id = %s,
                      price_source = 'hb_collection', price_checked_at = now() - interval '30 days'
                WHERE external_id = 'HBCV0000DD01'""",
            (offer_id,),
        )
    from feeds.discovery_catalog import mark_stale

    with _app() as conn:
        assert mark_stale(conn, "hepsiburada") == 1
    assert _row(env, "HBCV0000DD01")["price_state"] == "stale"
