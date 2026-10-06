"""Kabul kriteri: idempotentlik, uctan uca, gercek veritabanina.

Kurulum ve temizlik SAHIP rolle, boru hatti UYGULAMA rolu (`arilla_app`) ile
calisir. Bu ayrim kasitli:

  * `arilla_app` `price_point` satirlarini SILEMEZ (migrations/0010), yani
    temizlik baska turlu zaten yapilamaz;
  * boru hattinin gercekten uygulama yetkileriyle yettigi kanitlanir.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from pathlib import Path

import psycopg
import pytest

from collect.pipeline import run_ingest
from db.connection import database_url

pytestmark = pytest.mark.integration

MERCHANT_SLUG = "test-fixture-merchant"

# psycopg3 tek bir execute() icinde parametreli COK IFADE calistiramaz;
# bagimlilik sirasina gore tek tek gider.
CLEANUP_STATEMENTS = (
    """DELETE FROM variant_stock_event WHERE variant_id IN (
        SELECT v.id FROM offer_variant v
          JOIN offer o ON o.id = v.offer_id
          JOIN merchant m ON m.id = o.merchant_id
         WHERE m.slug = %(slug)s)""",
    """DELETE FROM offer_variant WHERE offer_id IN (
        SELECT o.id FROM offer o JOIN merchant m ON m.id = o.merchant_id
         WHERE m.slug = %(slug)s)""",
    """DELETE FROM price_point WHERE offer_id IN (
        SELECT o.id FROM offer o JOIN merchant m ON m.id = o.merchant_id
         WHERE m.slug = %(slug)s)""",
    "DELETE FROM offer WHERE merchant_id IN (SELECT id FROM merchant WHERE slug = %(slug)s)",
    "DELETE FROM ingest_run WHERE merchant_id IN (SELECT id FROM merchant WHERE slug = %(slug)s)",
    "DELETE FROM merchant WHERE slug = %(slug)s",
)

INSERT_MERCHANT = """
INSERT INTO merchant (slug, name, domain, source_type, feed_url, feed_config)
VALUES (%s, 'Test Fixture Magaza', 'test-fixture.example', 'xml_feed', %s, %s)
RETURNING id
"""

OFFERS = "SELECT count(*) FROM offer WHERE merchant_id = %s"

PRICE_POINTS = """
SELECT count(*) FROM price_point pp
  JOIN offer o ON o.id = pp.offer_id
 WHERE o.merchant_id = %s
"""

STOCK_EVENTS = """
SELECT count(*) FROM variant_stock_event e
  JOIN offer_variant v ON v.id = e.variant_id
  JOIN offer o ON o.id = v.offer_id
 WHERE o.merchant_id = %s
"""


def _owner() -> psycopg.Connection:
    return psycopg.connect(database_url("DATABASE_URL_OWNER"))


def _app() -> psycopg.Connection:
    """Boru hattinin kullandigi baglanti: uygulama rolu."""
    return psycopg.connect(database_url("DATABASE_URL"))


@pytest.fixture
def merchant(feed_v1: Path, xml_feed_config: dict) -> Iterator[int]:
    try:
        owner = _owner()
    except psycopg.OperationalError as error:  # pragma: no cover
        pytest.skip(f"yerel veritabani yok: {error}")

    with owner:
        with owner.cursor() as cur:
            for statement in CLEANUP_STATEMENTS:
                cur.execute(statement, {"slug": MERCHANT_SLUG})
            cur.execute(INSERT_MERCHANT, (MERCHANT_SLUG, str(feed_v1), json.dumps(xml_feed_config)))
            row = cur.fetchone()
            assert row is not None
            merchant_id = int(row[0])
        owner.commit()

        yield merchant_id

        with owner.cursor() as cur:
            for statement in CLEANUP_STATEMENTS:
                cur.execute(statement, {"slug": MERCHANT_SLUG})
        owner.commit()


def _set_feed(merchant_id: int, path: Path) -> None:
    with _owner() as owner:
        with owner.cursor() as cur:
            cur.execute("UPDATE merchant SET feed_url = %s WHERE id = %s", (str(path), merchant_id))
        owner.commit()


def _count(sql: str, merchant_id: int) -> int:
    with _owner() as conn, conn.cursor() as cur:
        cur.execute(sql, (merchant_id,))
        row = cur.fetchone()
        return int(row[0]) if row else 0


def test_first_run_writes_one_hundred_offers(merchant: int) -> None:
    with _app() as conn:
        result = run_ingest(conn, MERCHANT_SLUG)

    assert result.status == "success"
    assert result.offers_seen == 100
    assert result.counts.offers_created == 100
    assert result.counts.offers_updated == 0
    assert result.counts.price_points_written == 100
    assert _count(OFFERS, merchant) == 100
    assert _count(PRICE_POINTS, merchant) == 100


def test_second_run_is_idempotent_and_unchanged_prices_add_no_history(merchant: int) -> None:
    """Kabul kriterinin ta kendisi.

    Ayni feed ikinci kez islendiginde YENI OFFER OLUSMAZ ve fiyat/liste fiyati/stok
    degismedigi icin YENI `price_point` da olusmaz (karar 0065): gecmis yalnizca
    degisimde buyur; tazelik `offer.last_seen_at`'tedir.
    """
    with _app() as conn:
        first = run_ingest(conn, MERCHANT_SLUG)
    with _app() as conn:
        second = run_ingest(conn, MERCHANT_SLUG)

    assert first.counts.offers_created == 100
    assert second.counts.offers_created == 0
    assert second.counts.offers_updated == 100

    assert _count(OFFERS, merchant) == 100
    assert _count(PRICE_POINTS, merchant) == 100
    assert second.counts.price_points_written == 0


def test_stock_events_only_on_change(merchant: int, feed_v2: Path) -> None:
    """`variant_stock_event` yalnizca durum DEGISTIGINDE yazilir."""
    with _app() as conn:
        run_ingest(conn, MERCHANT_SLUG)
    after_first = _count(STOCK_EVENTS, merchant)
    # Ilk gorulme de bir olaydir: 100 urun x 3 beden.
    assert after_first == 300

    # Ayni feed tekrar: hicbir bedende durum degismedi -> yeni olay YOK.
    with _app() as conn:
        run_ingest(conn, MERCHANT_SLUG)
    assert _count(STOCK_EVENTS, merchant) == after_first

    # Degisen feed: yalnizca stogu degisen bedenler olay uretir.
    _set_feed(merchant, feed_v2)
    with _app() as conn:
        run_ingest(conn, MERCHANT_SLUG)
    delta = _count(STOCK_EVENTS, merchant) - after_first
    assert 0 < delta < 300


def test_price_changes_are_recorded(merchant: int, feed_v2: Path) -> None:
    with _app() as conn:
        run_ingest(conn, MERCHANT_SLUG)
    _set_feed(merchant, feed_v2)
    with _app() as conn:
        run_ingest(conn, MERCHANT_SLUG)

    with _owner() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT count(*) FROM (
                SELECT pp.offer_id FROM price_point pp
                  JOIN offer o ON o.id = pp.offer_id
                 WHERE o.merchant_id = %s
                 GROUP BY pp.offer_id HAVING count(DISTINCT pp.price) > 1
            ) changed
            """,
            (merchant,),
        )
        row = cur.fetchone()
    assert row is not None
    # Fixture'da her 5. urunun fiyati dustu.
    assert row[0] == 20


def test_ingest_run_is_always_recorded(merchant: int) -> None:
    """Sessiz basarisizlik kabul edilmez: her kosu bir satir birakir."""
    with _app() as conn:
        run_ingest(conn, MERCHANT_SLUG)
    with _app() as conn:
        run_ingest(conn, MERCHANT_SLUG)

    with _owner() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT status, offers_seen, offers_created, offers_updated, price_points_written
              FROM ingest_run WHERE merchant_id = %s ORDER BY started_at
            """,
            (merchant,),
        )
        runs = cur.fetchall()

    assert len(runs) == 2
    assert [run[0] for run in runs] == ["success", "success"]
    assert runs[0][2] == 100
    assert runs[0][3] == 0
    assert runs[1][2] == 0
    assert runs[1][3] == 100
    # Ilk kosu 100 nokta yazar; fiyat degismeyen ikinci kosu hic nokta yazmaz (0065).
    assert [run[4] for run in runs] == [100, 0]


def test_pipeline_cannot_update_price_point(merchant: int) -> None:
    """Append-only kurali motorda: uygulama rolu fiyat gecmisini degistiremez."""
    with _app() as conn:
        run_ingest(conn, MERCHANT_SLUG)

    with _app() as conn, conn.cursor() as cur, pytest.raises(psycopg.errors.InsufficientPrivilege):
        cur.execute("UPDATE price_point SET price = 1 WHERE false")


def test_failed_run_before_first_chunk_leaves_no_writes(
    merchant: int, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Ilk chunk commit edilmeden kesilen kosu `failed` kapanir ve HIC yazim birakmaz.

    50. kayitta beklenmeyen bir hata; chunk boyu 100 oldugundan hicbir sey
    veritabanina ulasmadi. `offers_seen` gercek (50), sayaclar 0 (karar 0055/0065).
    """
    import collect.pipeline as pipeline

    real_normalize = pipeline.normalize
    calls = {"n": 0}

    def flaky(record, mapping):  # type: ignore[no-untyped-def]
        calls["n"] += 1
        if calls["n"] == 50:
            raise RuntimeError("baglanti koptu https://feed.example/x.xml?token=abc")
        return real_normalize(record, mapping)

    monkeypatch.setattr(pipeline, "normalize", flaky)

    with _app() as conn, pytest.raises(RuntimeError):
        run_ingest(conn, MERCHANT_SLUG)

    assert _count(OFFERS, merchant) == 0
    assert _count(PRICE_POINTS, merchant) == 0
    with _owner() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT status, offers_seen, offers_created, offers_updated, price_points_written,
                   error_text, finished_at IS NOT NULL, checkpoint->>'resumable'
              FROM ingest_run WHERE merchant_id = %s
            """,
            (merchant,),
        )
        rows = cur.fetchall()
    assert len(rows) == 1
    status, seen, created, updated, points, error_text, finished, resumable = rows[0]
    assert (status, seen, created, updated, points, finished) == ("failed", 50, 0, 0, 0, True)
    assert resumable == "false"
    assert "baglanti koptu" in error_text


# --- chunk'li ve checkpoint'li yazim (karar 0065) ---------------------------------------


CHUNK = 30  # 100 teklif -> 4 chunk (30, 30, 30, 10)


def _runs(merchant_id: int) -> list[tuple]:
    with _owner() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT id, status, offers_seen, offers_created, offers_updated,
                   price_points_written, checkpoint, error_text
              FROM ingest_run WHERE merchant_id = %s ORDER BY id
            """,
            (merchant_id,),
        )
        return cur.fetchall()


def _fail_on_nth_batch(monkeypatch: pytest.MonkeyPatch, nth: int, error: BaseException) -> dict:
    """`write_batch`'in `nth` cagrisi patlar (oncekiler gercekten yazar)."""
    from collect.writer import OfferWriter

    real = OfferWriter.write_batch
    state = {"calls": 0, "armed": True}

    def flaky(self, offers):  # type: ignore[no-untyped-def]
        state["calls"] += 1
        if state["armed"] and state["calls"] == nth:
            raise error
        return real(self, offers)

    monkeypatch.setattr(OfferWriter, "write_batch", flaky)
    return state


def test_multi_chunk_ingest_succeeds_with_checkpoint(merchant: int) -> None:
    with _app() as conn:
        result = run_ingest(conn, MERCHANT_SLUG, chunk_size=CHUNK)

    assert result.status == "success"
    assert result.chunks == 4
    assert result.counts.offers_created == 100
    assert _count(OFFERS, merchant) == 100
    ((_, status, seen, created, _u, points, checkpoint, _e),) = _runs(merchant)
    assert (status, seen, created, points) == ("success", 100, 100, 100)
    assert checkpoint["state"] == "completed"
    assert checkpoint["chunks"] == 4
    assert checkpoint["offers_committed"] == 100
    assert checkpoint["resumable"] is False


def test_second_chunk_failure_keeps_first_chunk_and_never_reports_success(
    merchant: int, monkeypatch: pytest.MonkeyPatch
) -> None:
    from collect.pipeline import IngestInterrupted

    _fail_on_nth_batch(monkeypatch, 2, RuntimeError("baglanti koptu"))

    with _app() as conn, pytest.raises(IngestInterrupted) as raised:
        run_ingest(conn, MERCHANT_SLUG, chunk_size=CHUNK)

    assert raised.value.result.status == "partial"
    assert _count(OFFERS, merchant) == CHUNK  # ilk chunk korundu, ikincisi geri alindi
    assert _count(PRICE_POINTS, merchant) == CHUNK
    ((_, status, seen, created, _u, points, checkpoint, error_text),) = _runs(merchant)
    assert status == "partial"  # asla success degil
    assert created == CHUNK and points == CHUNK  # kalici sayilar, geri alinan sayilmaz
    assert checkpoint["state"] == "interrupted"
    assert checkpoint["resumable"] is True
    assert checkpoint["chunks"] == 1
    assert "baglanti koptu" in error_text


def test_retry_resumes_from_checkpoint_without_duplicates(
    merchant: int, monkeypatch: pytest.MonkeyPatch
) -> None:
    from collect.pipeline import IngestInterrupted

    state = _fail_on_nth_batch(monkeypatch, 2, RuntimeError("baglanti koptu"))
    with _app() as conn, pytest.raises(IngestInterrupted):
        run_ingest(conn, MERCHANT_SLUG, chunk_size=CHUNK)
    state["armed"] = False  # tekrar denemede hata yok

    with _app() as conn:
        resumed = run_ingest(conn, MERCHANT_SLUG, chunk_size=CHUNK)

    first_id, second_id = (run[0] for run in _runs(merchant))
    assert resumed.status == "success"
    assert resumed.resumed_from == first_id
    # Yalnizca kalan 70 teklif yazildi; ilk 30'u devralindi.
    assert resumed.counts.offers_created == 70
    assert resumed.counts.offers_updated == 0
    assert _count(OFFERS, merchant) == 100
    assert _count(PRICE_POINTS, merchant) == 100  # ayni observed_at: cift nokta yok
    with _owner() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT count(*) FROM (SELECT 1 FROM offer WHERE merchant_id = %s"
            " GROUP BY external_id HAVING count(*) > 1) d",
            (merchant,),
        )
        row = cur.fetchone()
        assert row is not None and row[0] == 0
    runs = _runs(merchant)
    assert runs[0][6]["resumable"] is False  # bir kez devralinir
    assert runs[0][6]["resumed_by"] == second_id
    assert runs[1][6]["resumed_from"] == first_id
    assert "30 teklif onceki kosuda yazilmisti" in runs[1][7]


def test_killed_process_is_reaped_and_resumed(
    merchant: int, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Surec aniden olurse (KeyboardInterrupt `except Exception`'a girmez)
    `running` satir kalir; sonraki kosu onu `partial/resumable`'a cevirip devralir."""
    state = _fail_on_nth_batch(monkeypatch, 3, KeyboardInterrupt())
    with _app() as conn, pytest.raises(KeyboardInterrupt):
        run_ingest(conn, MERCHANT_SLUG, chunk_size=CHUNK)
    state["armed"] = False
    assert _runs(merchant)[0][1] == "running"
    assert _count(OFFERS, merchant) == 2 * CHUNK

    with _app() as conn:
        resumed = run_ingest(conn, MERCHANT_SLUG, chunk_size=CHUNK)

    runs = _runs(merchant)
    assert runs[0][1] == "partial"
    assert runs[0][6]["state"] == "interrupted"
    assert resumed.status == "success"
    assert resumed.counts.offers_created == 40
    assert _count(OFFERS, merchant) == 100


def test_concurrent_run_is_refused_not_duplicated(merchant: int) -> None:
    with _app() as holder, holder.cursor() as cur:
        cur.execute("SELECT pg_advisory_lock(4301, %s)", (merchant,))  # baska surec tutuyor
        with _app() as conn:
            result = run_ingest(conn, MERCHANT_SLUG, chunk_size=CHUNK)

    assert result.refusal == "run_in_progress"
    assert result.status == "failed"
    assert _count(OFFERS, merchant) == 0
    assert _runs(merchant) == []


def test_no_resume_starts_fresh_with_new_observed_at(
    merchant: int, monkeypatch: pytest.MonkeyPatch
) -> None:
    from collect.pipeline import IngestInterrupted

    state = _fail_on_nth_batch(monkeypatch, 2, RuntimeError("x"))
    with _app() as conn, pytest.raises(IngestInterrupted):
        run_ingest(conn, MERCHANT_SLUG, chunk_size=CHUNK)
    state["armed"] = False

    with _app() as conn:
        result = run_ingest(conn, MERCHANT_SLUG, chunk_size=CHUNK, resume=False)

    assert result.resumed_from is None
    assert result.status == "success"
    assert result.counts.offers_updated == CHUNK  # ilk 30 yeniden upsert
    assert _count(OFFERS, merchant) == 100


def test_chunked_rerun_with_unchanged_prices_writes_no_price_history(
    merchant: int, feed_v2: Path
) -> None:
    with _app() as conn:
        run_ingest(conn, MERCHANT_SLUG, chunk_size=CHUNK)
    with _app() as conn:
        again = run_ingest(conn, MERCHANT_SLUG, chunk_size=CHUNK)
    assert again.counts.price_points_written == 0
    assert _count(PRICE_POINTS, merchant) == 100

    # Fiyati degisen her 5. urun yeni nokta alir; digerleri almaz.
    _set_feed(merchant, feed_v2)
    with _app() as conn:
        changed = run_ingest(conn, MERCHANT_SLUG, chunk_size=CHUNK)
    assert changed.counts.price_points_written == 20
    assert _count(PRICE_POINTS, merchant) == 120


def test_chunk_costs_a_constant_number_of_statements(
    merchant: int, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Round-trip kaniti: chunk basina ifade sayisi teklif/varyant sayisina bagli degil."""
    executed: list[str] = []
    real = psycopg.Cursor.execute

    def counting(self, query, params=None, **kwargs):  # type: ignore[no-untyped-def]
        executed.append(str(query))
        return real(self, query, params, **kwargs)

    monkeypatch.setattr(psycopg.Cursor, "execute", counting)
    with _app() as conn:
        result = run_ingest(conn, MERCHANT_SLUG, chunk_size=100)

    assert result.chunks == 1
    writes = [q for q in executed if "unnest" in q or "= ANY" in q]
    # 100 teklif x 3 varyant: eskiden ~2*100 + 5*300 = 1.700 ifade; simdi sabit ~9.
    assert len(writes) <= 10, len(writes)
    assert _count(OFFERS, merchant) == 100


def test_batch_with_duplicate_external_id_keeps_the_last() -> None:
    from datetime import UTC, datetime

    from collect.records import NormalizedOffer
    from collect.writer import OfferWriter

    try:
        owner = _owner()
    except psycopg.OperationalError as error:  # pragma: no cover
        pytest.skip(f"yerel veritabani yok: {error}")

    with owner, owner.cursor() as cur:
        cur.execute("SELECT id FROM merchant WHERE slug = 'riva-istanbul'")
        row = cur.fetchone()
        assert row is not None
        writer = OfferWriter(owner, row[0], datetime.now(UTC), dedupe_price_points=True)

        def offer(title: str) -> NormalizedOffer:
            return NormalizedOffer(
                external_id="dup-1",
                url="https://x.example/p",
                title_raw=title,
                current_price=1000,
                list_price=None,
                in_stock=True,
                currency="TRY",
            )

        ids = writer.write_batch([offer("ilk"), offer("son")])
        assert len(ids) == 2 and ids[0] == ids[1]
        cur.execute("SELECT title_raw FROM offer WHERE id = %s", (ids[0],))
        assert cur.fetchone() == ("son",)
        owner.rollback()


def test_close_run_falls_back_to_fresh_connection_when_connection_is_lost(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Uzun kosuda baglanti koparsa kosu kaydi YENI bir baglantiyla kapanir (karar 0065)."""
    from contextlib import contextmanager

    import collect.pipeline as pipeline
    from collect.writer import WriteCounts

    calls: list[object] = []

    def fake_close(conn, *args):  # type: ignore[no-untyped-def]
        calls.append(conn)
        if conn == "dead":
            raise psycopg.OperationalError("the connection is lost")

    @contextmanager
    def fake_connect():  # type: ignore[no-untyped-def]
        yield "fresh"

    monkeypatch.setattr(pipeline, "_close_run_on", fake_close)
    monkeypatch.setattr(pipeline, "connect", fake_connect)

    pipeline._close_run("dead", 5, "partial", 10, WriteCounts(), ["x"], 0)  # type: ignore[arg-type]

    assert calls == ["dead", "fresh"]
