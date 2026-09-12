"""Kok catch-all'in Redis tuketicisi (D4).

`apps/web`'in `packages/core/src/discovery/link-resolution.ts`'i her yeni
linki `queue:link_resolution` listesine `{"request_id": "<uuid>"}` olarak
LPUSH'lar. Bu worker BRPOP ile ayni listeyi tuketir - klasik FIFO kuyruk.

Mimari sinir (`CLAUDE.md`): TypeScript ve Python birbirini HTTP ile
cagirmiyor; tek kanal Postgres (`link_resolution_request` satiri) ve bu
Redis listesi. Worker `resolve_url`'i `__main__.py`'nin tekil-URL yolundaki
ile AYNI fonksiyonla cagirir; tek fark girdi kaynagi (CLI argumani yerine
kuyruk mesaji) ve sonucun bir satira yazilmasi (STDOUT yerine).
"""

from __future__ import annotations

import json
import logging
import time
from datetime import UTC, datetime

import httpx
import psycopg
import redis

from collect.link import urls
from collect.link.resolver import ResolutionFailed, resolve_url
from collect.link.robots import RobotsCache
from collect.records import RecordRejected

logger = logging.getLogger(__name__)

QUEUE_KEY = "queue:link_resolution"

#: BRPOP bu sureden uzun bloklamaz - Ctrl+C'nin makul surede yakalanmasi icin.
POLL_TIMEOUT_SECONDS = 5.0


def _mark(
    conn: psycopg.Connection,
    request_id: str,
    *,
    status: str,
    offer_id: int | None = None,
    error_text: str | None = None,
    finished: bool = False,
) -> None:
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE link_resolution_request
            SET status = %(status)s,
                offer_id = COALESCE(%(offer_id)s, offer_id),
                error_text = %(error_text)s,
                finished_at = CASE WHEN %(finished)s THEN %(now)s ELSE finished_at END
            WHERE id = %(id)s
            """,
            {
                "status": status,
                "offer_id": offer_id,
                "error_text": error_text,
                "finished": finished,
                "now": datetime.now(UTC),
                "id": request_id,
            },
        )
    conn.commit()


def process_one(
    conn: psycopg.Connection,
    request_id: str,
    *,
    client: httpx.Client | None = None,
    robots: RobotsCache | None = None,
) -> None:
    """Tek bir kuyruk mesajini isler. Satir yoksa ya da zaten islenmisse sessizce doner."""
    with conn.cursor() as cur:
        cur.execute(
            "SELECT url_raw, status FROM link_resolution_request WHERE id = %s",
            (request_id,),
        )
        row = cur.fetchone()
    if row is None:
        logger.warning("bilinmeyen link_resolution_request: %s", request_id)
        return
    url_raw, status = row
    if status != "queued":
        # Ayni mesaj iki kez teslim edilmis olabilir (Redis en-az-bir-kez
        # garantisi verir) - `docs/decisions/0014` deseniyle ayni: yeniden
        # islemek yerine atla.
        logger.info("zaten islenmis (%s), atlaniyor: %s", status, request_id)
        return

    _mark(conn, request_id, status="processing")

    try:
        resolved = resolve_url(conn, url_raw, client=client, robots=robots)
    except (urls.InvalidUrl, ResolutionFailed, RecordRejected, httpx.HTTPError) as error:
        conn.rollback()
        _mark(conn, request_id, status="failed", error_text=str(error), finished=True)
        logger.info("cozumlenemedi (%s): %s", request_id, error)
        return

    conn.commit()
    _mark(conn, request_id, status="resolved", offer_id=resolved.offer_id, finished=True)
    logger.info("cozumlendi: %s -> offer %s", request_id, resolved.offer_id)


def run_worker(
    conn: psycopg.Connection,
    redis_client: redis.Redis,
    *,
    poll_timeout: float = POLL_TIMEOUT_SECONDS,
    max_iterations: int | None = None,
) -> None:
    """Kuyruk bosaldiginda bloklayarak bekler; `max_iterations` yalnizca testler icin."""
    iterations = 0
    while max_iterations is None or iterations < max_iterations:
        iterations += 1
        item = redis_client.brpop([QUEUE_KEY], timeout=poll_timeout)
        if item is None:
            continue
        _, raw = item
        try:
            payload = json.loads(raw)
            request_id = payload["request_id"]
        except (json.JSONDecodeError, KeyError, TypeError):
            logger.error("kuyruk mesaji ayristirilamadi: %r", raw)
            continue

        try:
            process_one(conn, request_id)
        except Exception:
            # Tek bir mesajdaki beklenmeyen bir hata worker'i dusurmemeli -
            # bir sonraki mesaj islenmeye devam eder.
            conn.rollback()
            logger.exception("beklenmeyen hata, mesaj atlandi: %s", request_id)
            time.sleep(1)
