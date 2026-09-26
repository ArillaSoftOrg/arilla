"""Kok catch-all'in ve link aramasinin Redis tuketicisi (D4, docs/decisions/0035).

`apps/web`'in `packages/core/src/discovery/link-resolution.ts`'i her yeni
linki `queue:link_resolution` listesine `{"request_id": "<uuid>"}` olarak
LPUSH'lar. Bu worker BRPOP ile ayni listeyi tuketir - klasik FIFO kuyruk.

Mimari sinir (`CLAUDE.md`): TypeScript ve Python birbirini HTTP ile
cagirmiyor; tek kanal Postgres (`link_resolution_request` satiri) ve bu
Redis listesi. Worker `resolve_url`'i `__main__.py`'nin tekil-URL yolundaki
ile AYNI fonksiyonla cagirir; tek fark girdi kaynagi (CLI argumani yerine
kuyruk mesaji) ve sonucun bir satira yazilmasi (STDOUT yerine).

Link aramasi icin satira uc sey daha yazilir: sayfadan okunan sinyaller
(`source`), kararli durum kodu (`error_code`) ve kaynak gorselin embedding'i
(`image_embedding_id`). Gorsel embedding'i istek yolunda DEGIL burada uretilir
(CLAUDE.md kural 1); basarisiz olursa istek yine cozulur, arama metinle yurur.
Satir 'resolved'/'failed' olmadan once hicbir yarim sonuc gorunmez.
"""

from __future__ import annotations

import json
import logging
import time
from datetime import UTC, datetime
from typing import Any

import httpx
import psycopg
import redis
from psycopg.types.json import Jsonb

from collect.link import urls
from collect.link.resolver import ResolutionFailed, ResolvedLink, resolve_url
from collect.link.robots import USER_AGENT, RobotsCache
from collect.link.safe_http import guarded_client
from collect.records import RecordRejected
from enrich.client import EmbeddingClient

logger = logging.getLogger(__name__)

QUEUE_KEY = "queue:link_resolution"

#: BRPOP bu sureden uzun bloklamaz - Ctrl+C'nin makul surede yakalanmasi icin.
POLL_TIMEOUT_SECONDS = 5.0
#: Redis'e ulasilamazsa yeniden denemeden once beklenen sure.
REDIS_RETRY_SECONDS = 2.0


def _mark(
    conn: psycopg.Connection,
    request_id: str,
    *,
    status: str,
    offer_id: int | None = None,
    error_text: str | None = None,
    error_code: str | None = None,
    normalized_url: str | None = None,
    source: dict[str, Any] | None = None,
    image_embedding_id: int | None = None,
    finished: bool = False,
) -> None:
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE link_resolution_request
            SET status = %(status)s,
                offer_id = COALESCE(%(offer_id)s, offer_id),
                error_text = %(error_text)s,
                error_code = %(error_code)s,
                -- Web tarafi yazdiysa ONUN degeri kalir: onbellek anahtaridir,
                -- yapistirilan adrese aittir (kisaltici yonlendirmesi degistirmez).
                normalized_url = COALESCE(normalized_url, %(normalized_url)s),
                source = COALESCE(%(source)s, source),
                image_embedding_id = COALESCE(%(image_embedding_id)s, image_embedding_id),
                finished_at = CASE WHEN %(finished)s THEN %(now)s ELSE finished_at END
            WHERE id = %(id)s
            """,
            {
                "status": status,
                "offer_id": offer_id,
                # Ayrinti yalnizca teshis icin; kullaniciya `error_code` gosterilir.
                "error_text": error_text[:500] if error_text else None,
                "error_code": error_code,
                "normalized_url": normalized_url,
                "source": Jsonb(source) if source is not None else None,
                "image_embedding_id": image_embedding_id,
                "finished": finished,
                "now": datetime.now(UTC),
                "id": request_id,
            },
        )
    conn.commit()


def _embed_source_image(
    conn: psycopg.Connection,
    resolved: ResolvedLink,
    embedder: EmbeddingClient | None,
    image_http: httpx.Client | None,
) -> tuple[int | None, str]:
    """Kaynak gorselin embedding'i -> (embedding id, `image_status`)."""
    if not resolved.image_url:
        return None, "missing"
    if resolved.offer_id is None:
        # Fiyatsiz referans: offer yok, vektorun baglanacagi katalog satiri yok.
        return None, "not_indexed"
    if embedder is None:
        return None, "unavailable"

    # Donguyu kirmamak icin gec import: enrich yalnizca gorsel gerektiginde.
    from enrich.pipeline import embed_offer_image

    try:
        embedding_id, counts = embed_offer_image(
            conn,
            embedder,
            resolved.offer_id,
            http=image_http or guarded_client(user_agent=USER_AGENT, follow_redirects=True),
        )
    except Exception:
        conn.rollback()
        logger.exception("kaynak gorsel embedding'i basarisiz: offer %s", resolved.offer_id)
        return None, "failed"
    if embedding_id is None:
        status = "rejected" if counts.skipped else "failed"
        return None, status
    return embedding_id, "embedded"


def process_one(
    conn: psycopg.Connection,
    request_id: str,
    *,
    client: httpx.Client | None = None,
    robots: RobotsCache | None = None,
    embedder: EmbeddingClient | None = None,
    image_http: httpx.Client | None = None,
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
        resolved = resolve_url(conn, url_raw, client=client, robots=robots, allow_reference=True)
    except ResolutionFailed as error:
        conn.rollback()
        _mark(
            conn,
            request_id,
            status="failed",
            error_text=str(error),
            error_code=error.code,
            finished=True,
        )
        logger.info("cozumlenemedi (%s, %s): %s", request_id, error.code, error)
        return
    except urls.InvalidUrl as error:
        conn.rollback()
        _mark(
            conn,
            request_id,
            status="failed",
            error_text=str(error),
            error_code="invalid_url",
            finished=True,
        )
        return
    except RecordRejected as error:
        conn.rollback()
        _mark(
            conn,
            request_id,
            status="failed",
            error_text=str(error),
            error_code="no_product",
            finished=True,
        )
        return
    except httpx.HTTPError as error:
        conn.rollback()
        _mark(
            conn,
            request_id,
            status="failed",
            error_text=type(error).__name__,
            error_code="fetch_failed",
            finished=True,
        )
        return

    conn.commit()

    embedding_id, image_status = _embed_source_image(conn, resolved, embedder, image_http)
    signals = {**resolved.signals, "image_status": image_status}

    _mark(
        conn,
        request_id,
        status="resolved",
        offer_id=resolved.offer_id,
        normalized_url=resolved.url,
        source=signals,
        image_embedding_id=embedding_id,
        finished=True,
    )
    logger.info(
        "cozumlendi: %s -> offer %s, gorsel %s", request_id, resolved.offer_id, image_status
    )


def run_worker(
    conn: psycopg.Connection,
    redis_client: redis.Redis,
    *,
    embedder: EmbeddingClient | None = None,
    poll_timeout: float = POLL_TIMEOUT_SECONDS,
    max_iterations: int | None = None,
) -> None:
    """Kuyruk bosaldiginda bloklayarak bekler; `max_iterations` yalnizca testler icin.

    Tek surec, tek is: ayni anda en fazla BIR dis sayfa getirilir. Daha fazla
    esanlilik istenirse birden fazla worker sureci calistirilir; her biri
    kendi istemcisini tutar.
    """
    page_client = guarded_client(user_agent=USER_AGENT)
    image_client = guarded_client(user_agent=USER_AGENT, follow_redirects=True)
    robots = RobotsCache()

    iterations = 0
    while max_iterations is None or iterations < max_iterations:
        iterations += 1
        try:
            item = redis_client.brpop([QUEUE_KEY], timeout=poll_timeout)
        except (redis.TimeoutError, redis.ConnectionError) as error:
            # Gecici Redis kesintisi worker'i dusurmemeli; bekle ve yeniden dene.
            logger.warning("kuyruk okunamadi, yeniden denenecek: %s", type(error).__name__)
            time.sleep(REDIS_RETRY_SECONDS)
            continue
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
            process_one(
                conn,
                request_id,
                client=page_client,
                robots=robots,
                embedder=embedder,
                image_http=image_client,
            )
        except Exception:
            # Tek bir mesajdaki beklenmeyen bir hata worker'i dusurmemeli -
            # bir sonraki mesaj islenmeye devam eder. Satir 'processing'de
            # kalmasin: arayuz sonsuza kadar beklemesin.
            conn.rollback()
            logger.exception("beklenmeyen hata, mesaj atlandi: %s", request_id)
            try:
                _mark(conn, request_id, status="failed", error_code="unexpected", finished=True)
            except Exception:
                conn.rollback()
            time.sleep(1)
