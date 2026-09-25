"""Toplama boru hatti: kapi -> tasima -> normalizasyon -> yazma -> `ingest_run`.

Her kosu `ingest_run` tablosuna yazilir. **Sessiz basarisizlik kabul edilmez**
(architecture.md §1): kosu patlasa bile satir `failed` olarak kapanir.

Kapi (`collect/gate.py`) connector kurulmadan once sorulur. Reddedilen kosu
da `ingest_run`'a `failed` + `refused:<kod>` olarak yazilir; magazaya istek
gitmez, offer ya da `price_point` yazilmaz.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

import psycopg

from collect import connector as connector_registry
from collect import sources  # noqa: F401  — uc tasimayi kayda ekler
from collect.gate import SHOPIFY_CURRENCY, ingest_refusal
from collect.mapping import FieldMapping
from collect.normalize import normalize
from collect.records import NormalizedOffer, RecordRejected
from collect.writer import OfferWriter, WriteCounts

logger = logging.getLogger(__name__)

#: `error_text` alanina sigacak kadar ornek tut; tamami log'a gider.
MAX_ERROR_SAMPLES = 5


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


def run_ingest(conn: psycopg.Connection, merchant_slug: str) -> IngestResult:
    merchant = _load_merchant(conn, merchant_slug)
    started_at = datetime.now(UTC)

    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO ingest_run (merchant_id, started_at, status) VALUES (%s, %s, 'running')"
            " RETURNING id",
            (merchant["id"], started_at),
        )
        row = cur.fetchone()
        assert row is not None
        run_id = int(row[0])
    # Kosu kaydi hemen gorunur olsun: sonrasinda ne olursa olsun izi kalir.
    conn.commit()

    refusal = ingest_refusal(merchant)
    if refusal is not None:
        logger.warning("ingest reddedildi %s: %s", merchant_slug, refusal.error_text)
        _close_run(conn, run_id, "failed", 0, WriteCounts(), [refusal.error_text], 0)
        return IngestResult(
            ingest_run_id=run_id,
            merchant_slug=merchant_slug,
            status="failed",
            offers_seen=0,
            counts=WriteCounts(),
            rejected=0,
            deactivated=0,
            refusal=refusal.code,
        )

    writer = OfferWriter(conn, merchant_id=merchant["id"], observed_at=started_at)
    offers_seen = 0
    rejected = 0
    errors: list[str] = []
    seen_external_ids: set[str] = set()
    duplicates = 0
    status = "success"
    deactivated = 0

    try:
        mapping = FieldMapping.from_config(merchant["feed_config"])
        source = connector_registry.build(
            merchant["source_type"], merchant["feed_url"], merchant["feed_config"]
        )

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

            writer.write(offer)

        if rejected:
            status = "partial"

        # Pasiflestirme yalnizca TAM DOKUM ve TEMIZ kosuda.
        if merchant["feed_config"].get("full_dump") and status == "success":
            deactivated = writer.deactivate_missing()

        conn.commit()

    except Exception as error:  # noqa: BLE001 — kosu ne olursa olsun kapatilir
        conn.rollback()
        status = "failed"
        errors.append(str(error))
        logger.exception("ingest kosusu basarisiz: %s", merchant_slug)
        _close_run(conn, run_id, status, offers_seen, writer.counts, errors, duplicates)
        raise

    _close_run(conn, run_id, status, offers_seen, writer.counts, errors, duplicates)

    return IngestResult(
        ingest_run_id=run_id,
        merchant_slug=merchant_slug,
        status=status,
        offers_seen=offers_seen,
        counts=writer.counts,
        rejected=rejected,
        deactivated=deactivated,
    )


def _check_currency(source_type: str, offer: NormalizedOffer) -> None:
    """Shopify teklifi TRY disinda yazilmaz (0031). Kapi `feed_config.currency`
    TRY'yi zaten sart kosar; bu, esleme bir kaynak para birimi alani eklerse
    diye kayit duzeyindeki ikinci kilittir."""
    if source_type == "shopify" and offer.currency != SHOPIFY_CURRENCY:
        raise RecordRejected(
            f"Shopify teklifi {SHOPIFY_CURRENCY} disinda: {offer.currency} ({offer.external_id})"
        )


def _close_run(
    conn: psycopg.Connection,
    run_id: int,
    status: str,
    offers_seen: int,
    counts: WriteCounts,
    errors: list[str],
    duplicates: int,
) -> None:
    notes = list(errors)
    if duplicates:
        notes.append(f"{duplicates} tekrarli external_id atlandi")
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE ingest_run SET
                finished_at          = now(),
                status               = %s,
                offers_seen          = %s,
                offers_created       = %s,
                offers_updated       = %s,
                price_points_written = %s,
                error_text           = %s
            WHERE id = %s
            """,
            (
                status,
                offers_seen,
                counts.offers_created,
                counts.offers_updated,
                counts.price_points_written,
                "\n".join(notes) if notes else None,
                run_id,
            ),
        )
    conn.commit()
