"""Toplama boru hatti: kapi -> tasima -> normalizasyon -> chunk'li yazma -> `ingest_run`.

Her kosu `ingest_run` tablosuna yazilir. **Sessiz basarisizlik kabul edilmez**
(architecture.md §1): kosu patlasa bile satir kapanir.

**Chunk'li ve checkpoint'li yazim (karar 0068).** Eskiden bir merchant'in
butun katalogu TEK islemdeydi; uzak veritabaninda 42 dakika sonra baglanti
koptu ve tum is geri alindi. Simdi:

- Normalize edilen teklifler `CHUNK_OFFERS` (100) adetlik gruplarda TEK
  toplu yazimla (`OfferWriter.write_batch`) yazilir ve her grup KENDI
  islemini commit eder. Teklif basina commit yoktur.
- Her commit, ayni islemde `ingest_run.checkpoint` + sayaclari + `updated_at`'i
  ilerletir: kalici checkpoint chunk ile atomik.
- Kosu yarida kesilirse commit edilmis chunk'lar KORUNUR. Kosu `partial` +
  `checkpoint.resumable = true` kapanir (asla `success` degil) ve
  `IngestInterrupted` firlatir. Ayni merchant icin yeniden baslatmada kosu,
  onceki kosunun `observed_at`'ini ve zaten yazilmis teklifleri
  (`last_seen_at = observed_at`) devralir; kalanini yazar. Upsert anahtarlari
  degismedigi icin duplicate olusmaz.
- Hic chunk commit edilmeden kesilen kosu `failed` kapanir (yazim yok).
- `success` yalnizca tum katalog yazildiginda ve hic kayit reddedilmediginde;
  reddedilen kayit varsa `partial` + `resumable = false` (eskisi gibi, tamamlandi).

Eszamanli iki kosuyu merchant basina oturum duzeyinde advisory lock engeller;
lock'u tutan surec oldugunde `running` satir olu sayilmaz, olmadiginda sayilir.

Kapi (`collect/gate.py`) connector kurulmadan once sorulur. Reddedilen kosu
da `ingest_run`'a `failed` + `refused:<kod>` olarak yazilir; magazaya istek
gitmez, offer ya da `price_point` yazilmaz. Connector da ilk katalog
isteginden once `IngestRefused` ile reddedebilir (Shopify robots.txt,
docs/decisions/0042); ayni sekilde kaydedilir.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from typing import Any

import psycopg

from collect import connector as connector_registry
from collect import sources  # noqa: F401  — uc tasimayi kayda ekler
from collect.gate import SHOPIFY_CURRENCY, IngestRefused, ingest_refusal
from collect.mapping import FieldMapping
from collect.normalize import normalize
from collect.records import NormalizedOffer, RecordRejected
from collect.writer import OfferWriter, WriteCounts
from db.connection import connect

logger = logging.getLogger(__name__)

#: `error_text` alanina sigacak kadar ornek tut; tamami log'a gider.
MAX_ERROR_SAMPLES = 5

#: Chunk basina teklif. Toplu yazimla bir chunk ~9 ifade (~1,5 sn uzak RTT);
#: 100 teklif ~2 Shopify sayfasi eder: commit RTT'si ihmal edilir, kesintide
#: kaybedilen is en fazla bir chunk (karar 0068).
CHUNK_OFFERS = 100

#: Devam ettirilebilir (`partial` + `resumable`) bir kosu bu sureden eskiyse
#: devralinmaz (katalog cok degismis olabilir); yeni kosu sifirdan baslar.
RESUME_WINDOW_SECONDS = 24 * 3600

#: `pg_try_advisory_lock(ADVISORY_NAMESPACE, merchant_id)`
ADVISORY_NAMESPACE = 4301


@dataclass
class IngestResult:
    ingest_run_id: int
    merchant_slug: str
    status: str
    offers_seen: int
    counts: WriteCounts
    rejected: int
    deactivated: int
    #: Kapi reddettiyse makine kodu (`merchant_inactive`, `currency_unverified`, ...).
    refusal: str | None = None
    #: Onceki yarim kosudan devralindiysa onun id'si.
    resumed_from: int | None = None
    chunks: int = 0


class IngestInterrupted(Exception):
    """Kosu yarida kesildi ama commit edilmis chunk'lar var: `partial` +
    `resumable`. Yeniden calistirmak kalan isi tamamlar (karar 0068)."""

    def __init__(self, result: IngestResult, cause: BaseException) -> None:
        super().__init__(
            f"{result.merchant_slug}: kosu {result.ingest_run_id} kesildi "
            f"({result.chunks} chunk kalici): {cause}"
        )
        self.result = result
        self.__cause__ = cause


def _load_merchant(conn: psycopg.Connection, slug: str) -> dict[str, Any]:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT id, slug, source_type, feed_url, feed_config, is_active
              FROM merchant WHERE slug = %s
            """,
            (slug,),
        )
        row = cur.fetchone()
    if row is None:
        raise LookupError(f"merchant bulunamadi: {slug!r}")
    return {
        "id": row[0],
        "slug": row[1],
        "source_type": row[2],
        "feed_url": row[3],
        "feed_config": row[4] or {},
        "is_active": row[5],
    }


# -- checkpoint -------------------------------------------------------------


def _checkpoint(
    state: str,
    observed_at: datetime,
    chunks: int,
    committed: int,
    last_external_id: str | None,
    *,
    resumable: bool,
    resumed_from: int | None,
) -> str:
    """Kucuk, duz JSON. Ham katalog yaniti ASLA buraya girmez (karar 0068)."""
    return json.dumps(
        {
            "v": 1,
            "state": state,
            "observed_at": observed_at.isoformat(),
            "chunks": chunks,
            "offers_committed": committed,
            "last_external_id": last_external_id,
            "resumable": resumable,
            "resumed_from": resumed_from,
        }
    )


def _write_progress(
    conn: psycopg.Connection,
    run_id: int,
    offers_seen: int,
    counts: WriteCounts,
    checkpoint: str,
) -> None:
    """Chunk yazimiyla AYNI islemde calisir; commit cagirana aittir."""
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE ingest_run SET
                updated_at           = now(),
                offers_seen          = %s,
                offers_created       = %s,
                offers_updated       = %s,
                price_points_written = %s,
                checkpoint           = %s::jsonb
            WHERE id = %s
            """,
            (
                offers_seen,
                counts.offers_created,
                counts.offers_updated,
                counts.price_points_written,
                checkpoint,
                run_id,
            ),
        )


def _try_lock(conn: psycopg.Connection, merchant_id: int) -> bool:
    with conn.cursor() as cur:
        cur.execute("SELECT pg_try_advisory_lock(%s, %s)", (ADVISORY_NAMESPACE, merchant_id))
        row = cur.fetchone()
    return bool(row and row[0])


def _unlock(conn: psycopg.Connection, merchant_id: int) -> None:
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT pg_advisory_unlock(%s, %s)", (ADVISORY_NAMESPACE, merchant_id))
        conn.commit()
    except psycopg.Error:  # baglanti zaten kopmus olabilir; kilit oturumla birlikte duser
        pass


@dataclass
class _Resume:
    run_id: int
    observed_at: datetime


def _claim_resumable(conn: psycopg.Connection, merchant_id: int) -> _Resume | None:
    """Advisory lock alindiktan sonra: lock'u tutan yok, yani `checkpoint`'i olan
    `running` satirlar olu surecten kalmadir. Onlari `partial`/`resumable`'a
    cevirir (en az bir chunk kalici ise) ya da `failed` kapatir; sonra en yeni
    devam ettirilebilir kosuyu doner."""
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE ingest_run SET
                status      = CASE WHEN coalesce((checkpoint->>'chunks')::int, 0) > 0
                                   THEN 'partial' ELSE 'failed' END,
                finished_at = now(),
                updated_at  = now(),
                error_text  = 'process_died: kosu sahibi surec yok (heartbeat kesildi)',
                checkpoint  = checkpoint || jsonb_build_object(
                                  'state', 'interrupted',
                                  'resumable', coalesce((checkpoint->>'chunks')::int, 0) > 0)
            WHERE merchant_id = %s AND status = 'running' AND checkpoint IS NOT NULL
            """,
            (merchant_id,),
        )
        cur.execute(
            """
            SELECT id, checkpoint->>'observed_at'
              FROM ingest_run
             WHERE merchant_id = %s AND status = 'partial'
               AND checkpoint->>'resumable' = 'true'
               AND updated_at > now() - make_interval(secs => %s)
             ORDER BY id DESC LIMIT 1
            """,
            (merchant_id, RESUME_WINDOW_SECONDS),
        )
        row = cur.fetchone()
    conn.commit()
    if row is None:
        return None
    return _Resume(run_id=int(row[0]), observed_at=datetime.fromisoformat(row[1]))


def _already_written(conn: psycopg.Connection, merchant_id: int, observed_at: datetime) -> set[str]:
    """Onceki surecte commit edilmis teklifler: `last_seen_at = observed_at`."""
    with conn.cursor() as cur:
        cur.execute(
            "SELECT external_id FROM offer WHERE merchant_id = %s AND last_seen_at = %s",
            (merchant_id, observed_at),
        )
        return {row[0] for row in cur.fetchall()}


def run_ingest(
    conn: psycopg.Connection,
    merchant_slug: str,
    *,
    chunk_size: int = CHUNK_OFFERS,
    resume: bool = True,
) -> IngestResult:
    if chunk_size < 1:
        raise ValueError("chunk_size >= 1 olmali")
    merchant = _load_merchant(conn, merchant_slug)
    conn.commit()

    if not _try_lock(conn, merchant["id"]):
        conn.commit()
        logger.warning("ingest zaten calisiyor %s", merchant_slug)
        return IngestResult(
            ingest_run_id=0,
            merchant_slug=merchant_slug,
            status="failed",
            offers_seen=0,
            counts=WriteCounts(),
            rejected=0,
            deactivated=0,
            refusal="run_in_progress",
        )
    conn.commit()
    try:
        return _run_locked(conn, merchant, chunk_size=chunk_size, resume=resume)
    finally:
        _unlock(conn, merchant["id"])


def _run_locked(
    conn: psycopg.Connection, merchant: dict[str, Any], *, chunk_size: int, resume: bool
) -> IngestResult:
    merchant_slug = merchant["slug"]
    previous = _claim_resumable(conn, merchant["id"]) if resume else None

    started_at = datetime.now(UTC)
    observed_at = previous.observed_at if previous else started_at
    resumed_from = previous.run_id if previous else None

    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO ingest_run (merchant_id, started_at, status, checkpoint)"
            " VALUES (%s, %s, 'running', %s::jsonb) RETURNING id",
            (
                merchant["id"],
                started_at,
                _checkpoint(
                    "running", observed_at, 0, 0, None, resumable=False, resumed_from=resumed_from
                ),
            ),
        )
        row = cur.fetchone()
        assert row is not None
        run_id = int(row[0])
        if previous:
            # Devralinan kosu bir kez devralinir.
            cur.execute(
                "UPDATE ingest_run SET checkpoint = checkpoint || jsonb_build_object("
                "'resumable', false, 'resumed_by', %s::bigint), updated_at = now() WHERE id = %s",
                (run_id, previous.run_id),
            )
    # Kosu kaydi hemen gorunur olsun: sonrasinda ne olursa olsun izi kalir.
    conn.commit()

    refusal = ingest_refusal(merchant)
    if refusal is not None:
        logger.warning("ingest reddedildi %s: %s", merchant_slug, refusal.error_text)
        _close_run(
            conn,
            run_id,
            "failed",
            0,
            WriteCounts(),
            [refusal.error_text],
            0,
            checkpoint=_checkpoint(
                "failed", observed_at, 0, 0, None, resumable=False, resumed_from=resumed_from
            ),
        )
        return IngestResult(
            ingest_run_id=run_id,
            merchant_slug=merchant_slug,
            status="failed",
            offers_seen=0,
            counts=WriteCounts(),
            rejected=0,
            deactivated=0,
            refusal=refusal.code,
            resumed_from=resumed_from,
        )

    writer = OfferWriter(
        conn, merchant_id=merchant["id"], observed_at=observed_at, dedupe_price_points=True
    )
    committed = WriteCounts()  # son commit'teki kalici sayilar
    committed_offers = 0
    chunks = 0
    last_external_id: str | None = None
    offers_seen = 0
    rejected = 0
    errors: list[str] = []
    seen_external_ids: set[str] = set()
    duplicates = 0
    skipped_resumed = 0
    status = "success"
    deactivated = 0
    buffer: list[NormalizedOffer] = []

    def flush() -> None:
        nonlocal committed, committed_offers, chunks, last_external_id
        if not buffer:
            return
        writer.write_batch(buffer)
        committed_offers += len(buffer)
        chunks += 1
        last_external_id = buffer[-1].external_id
        _write_progress(
            conn,
            run_id,
            offers_seen,
            writer.counts,
            _checkpoint(
                "running",
                observed_at,
                chunks,
                committed_offers,
                last_external_id,
                resumable=False,
                resumed_from=resumed_from,
            ),
        )
        conn.commit()  # chunk + checkpoint ATOMIK
        committed = replace(writer.counts)
        buffer.clear()

    try:
        mapping = FieldMapping.from_config(merchant["feed_config"])
        source = connector_registry.build(
            merchant["source_type"], merchant["feed_url"], merchant["feed_config"]
        )
        already = _already_written(conn, merchant["id"], observed_at) if previous else set()
        conn.commit()

        for record in source.fetch():
            offers_seen += 1
            try:
                offer = normalize(record, mapping)
                _check_currency(merchant["source_type"], offer)
            except RecordRejected as error:
                rejected += 1
                if len(errors) < MAX_ERROR_SAMPLES:
                    errors.append(f"{record.source_ref}: {error}")
                logger.warning("kayit reddedildi %s: %s", record.source_ref, error)
                continue

            # Feed icinde tekrarli external_id: ilkini al, digerlerini say.
            if offer.external_id in seen_external_ids:
                duplicates += 1
                continue
            seen_external_ids.add(offer.external_id)

            # Devralinan kosuda onceki surecte commit edilmis teklif: atla.
            if offer.external_id in already:
                skipped_resumed += 1
                continue

            buffer.append(offer)
            if len(buffer) >= chunk_size:
                flush()

        flush()

        if rejected:
            status = "partial"

        # Pasiflestirme yalnizca TAM DOKUM ve TEMIZ kosuda.
        if merchant["feed_config"].get("full_dump") and status == "success":
            deactivated = writer.deactivate_missing()

    except IngestRefused as refused:
        # Connector'un kendi kapisi (orn. Shopify robots.txt): kapi reddiyle
        # ayni sozlesme. Yazilmis chunk varsa kalir; yoksa sayac sifirdir.
        _safe_rollback(conn)
        refusal = refused.refusal
        logger.warning("ingest reddedildi %s: %s", merchant_slug, refusal.error_text)
        _close_run(
            conn,
            run_id,
            "failed",
            offers_seen,
            committed,
            [refusal.error_text],
            0,
            checkpoint=_checkpoint(
                "failed",
                observed_at,
                chunks,
                committed_offers,
                last_external_id,
                resumable=False,
                resumed_from=resumed_from,
            ),
        )
        return IngestResult(
            ingest_run_id=run_id,
            merchant_slug=merchant_slug,
            status="failed",
            offers_seen=offers_seen,
            counts=committed,
            rejected=rejected,
            deactivated=0,
            refusal=refusal.code,
            resumed_from=resumed_from,
            chunks=chunks,
        )

    except Exception as error:  # noqa: BLE001 — kosu ne olursa olsun kapatilir
        # Yalnizca commit edilmemis chunk geri alinir; onceki chunk'lar kalicidir.
        _safe_rollback(conn)
        errors.append(str(error))
        unwritten = _diff(writer.counts, committed)
        if unwritten:
            errors.append(unwritten)
        logger.exception("ingest kosusu kesildi: %s", merchant_slug)

        interrupted = chunks > 0
        status = "partial" if interrupted else "failed"
        checkpoint = _checkpoint(
            "interrupted" if interrupted else "failed",
            observed_at,
            chunks,
            committed_offers,
            last_external_id,
            resumable=interrupted,
            resumed_from=resumed_from,
        )
        _close_run(
            conn,
            run_id,
            status,
            offers_seen,
            committed,
            errors,
            duplicates,
            checkpoint=checkpoint,
        )
        if interrupted:
            raise IngestInterrupted(
                IngestResult(
                    ingest_run_id=run_id,
                    merchant_slug=merchant_slug,
                    status=status,
                    offers_seen=offers_seen,
                    counts=committed,
                    rejected=rejected,
                    deactivated=0,
                    resumed_from=resumed_from,
                    chunks=chunks,
                ),
                error,
            ) from error
        raise

    _close_run(
        conn,
        run_id,
        status,
        offers_seen,
        writer.counts,
        errors,
        duplicates,
        checkpoint=_checkpoint(
            "completed",
            observed_at,
            chunks,
            committed_offers,
            last_external_id,
            resumable=False,
            resumed_from=resumed_from,
        ),
        skipped_resumed=skipped_resumed,
    )

    return IngestResult(
        ingest_run_id=run_id,
        merchant_slug=merchant_slug,
        status=status,
        offers_seen=offers_seen,
        counts=writer.counts,
        rejected=rejected,
        deactivated=deactivated,
        resumed_from=resumed_from,
        chunks=chunks,
    )


def _check_currency(source_type: str, offer: NormalizedOffer) -> None:
    """Shopify teklifi TRY disinda yazilmaz (0031). Kapi `feed_config.currency`
    TRY'yi zaten sart kosar; bu, esleme bir kaynak para birimi alani eklerse
    diye kayit duzeyindeki ikinci kilittir."""
    if source_type == "shopify" and offer.currency != SHOPIFY_CURRENCY:
        raise RecordRejected(
            f"Shopify teklifi {SHOPIFY_CURRENCY} disinda: {offer.currency} ({offer.external_id})"
        )


def _diff(total: WriteCounts, committed: WriteCounts) -> str | None:
    """Commit edilmemis (geri alinan) son chunk'in ozeti; yoksa None."""
    created = total.offers_created - committed.offers_created
    updated = total.offers_updated - committed.offers_updated
    points = total.price_points_written - committed.price_points_written
    if not (created or updated or points):
        return None
    return (
        "son chunk geri alindi (kalici degil): "
        f"{created} yeni teklif, {updated} guncelleme, {points} fiyat noktasi"
    )


def _safe_rollback(conn: psycopg.Connection) -> None:
    try:
        conn.rollback()
    except psycopg.Error:  # baglanti kopmus: sunucu islemi zaten geri aldi
        logger.warning("rollback yapilamadi: baglanti kopuk")


def _close_run(
    conn: psycopg.Connection,
    run_id: int,
    status: str,
    offers_seen: int,
    counts: WriteCounts,
    errors: list[str],
    duplicates: int,
    *,
    checkpoint: str | None = None,
    skipped_resumed: int = 0,
) -> None:
    notes = list(errors)
    if duplicates:
        notes.append(f"{duplicates} tekrarli external_id atlandi")
    if skipped_resumed:
        notes.append(f"{skipped_resumed} teklif onceki kosuda yazilmisti, devralindi")
    try:
        _close_run_on(conn, run_id, status, offers_seen, counts, notes, checkpoint)
    except psycopg.OperationalError:
        # Baglanti kopmus (uzun kosuda tipik): kaydi yeni, kisa bir baglantiyla kapat.
        logger.warning("kosu kaydi yeni baglantiyla kapatiliyor: %s", run_id)
        with connect() as fresh:
            _close_run_on(fresh, run_id, status, offers_seen, counts, notes, checkpoint)


def _close_run_on(
    conn: psycopg.Connection,
    run_id: int,
    status: str,
    offers_seen: int,
    counts: WriteCounts,
    notes: list[str],
    checkpoint: str | None,
) -> None:
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE ingest_run SET
                finished_at          = now(),
                updated_at           = now(),
                status               = %s,
                offers_seen          = %s,
                offers_created       = %s,
                offers_updated       = %s,
                price_points_written = %s,
                error_text           = %s,
                checkpoint           = coalesce(%s::jsonb, checkpoint)
            WHERE id = %s
            """,
            (
                status,
                offers_seen,
                counts.offers_created,
                counts.offers_updated,
                counts.price_points_written,
                "\n".join(notes) if notes else None,
                checkpoint,
                run_id,
            ),
        )
    conn.commit()
