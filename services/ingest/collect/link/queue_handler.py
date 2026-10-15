"""Vercel Queues mesajini isleyen kuyruk-bagimsiz mantik (docs/decisions/0107).

`subscriber.py` yalnizca `vercel.queue` ile bu fonksiyon arasinda ince bir
kopru kurar; SDK burada ice aktarilmaz, bu yuzden mantik SDK olmadan test edilir.

Mesaj: `{"request_id": "<uuid>"}`. Durumun tek dogrusu PostgreSQL'dir
(`link_resolution_request`). Teslimat en-az-bir-kez oldugundan:

- satir atomik sahiplenilir (`claim_request`); bitmis satir atlanir,
- ilk teslimatta yalnizca `queued`, yeniden teslimatta (onceki deneme dustu)
  takili `processing` satir da alinabilir,
- sitenin durumu (404, robots, SSRF engeli ...) kalici sonuctur: `failed`
  yazilir, mesaj onaylanir, YENIDEN DENENMEZ,
- altyapi hatasi `TransientFailure` ile yeniden denenir; son teslimatta satir
  `failed`/`unexpected` yapilip mesaj onaylanir (kuyrukta zehirli mesaj kalmaz).

SSRF korumasi, robots, URL dogrulama ve gorsel esigi `resolve_claimed`
icindedir ve degismemistir.
"""

from __future__ import annotations

import enum
import logging
import re
import threading
from collections.abc import Callable
from contextlib import AbstractContextManager

import httpx
import psycopg

from collect.link.robots import USER_AGENT, RobotsCache
from collect.link.safe_http import guarded_client
from collect.link.worker import _mark, claim_request, resolve_claimed
from db.connection import connect_pooled, env
from enrich.client import EmbeddingClient, JinaEmbeddingClient
from enrich.ratelimit import TokenBudget, tokens_per_minute_from_env

logger = logging.getLogger(__name__)

#: Web (`packages/core/src/discovery/link-queue.ts`) ile AYNI olmali.
LINK_TOPIC = "link-resolution"

#: Abone yapilandirmasi (`subscriber.py`) ve son-teslimat kontrolu icin tek kaynak.
MAX_ATTEMPTS = 3
RETRY_BASE_SECONDS = 15
RETRY_MAX_SECONDS = 60
#: Es zamanli en fazla bu kadar cagri: Jina butcesi ve DB baglantisi icin tavan.
MAX_CONCURRENCY = 2

#: Kullanici bekliyor: saglayici 429/5xx verirse toplu kosudaki gibi dakikalarca
#: denenmez. Iki deneme; olmazsa istek gorselsiz (metinle) cozulur.
EMBED_ATTEMPTS = 2

#: `TokenBudget`/`RobotsCache` es zamanlilik icin yazilmadi (eski worker da surec
#: basina tek sayfa getirirdi): ayni ornekteki cagrilar siraya girer.
_RESOLVE_LOCK = threading.Lock()

_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)


class Outcome(enum.Enum):
    RESOLVED_OR_FAILED = "done"  # satir bu cagrida bir son duruma ulasti
    SKIPPED = "skipped"  # satir yok / baskasi aldi / zaten bitmis
    INVALID = "invalid"  # mesaj bozuk; yeniden denemenin anlami yok
    GAVE_UP = "gave_up"  # son teslimat: satir `failed`/`unexpected`


class TransientFailure(RuntimeError):
    """Gecici altyapi hatasi: mesaj `delay` sn sonra yeniden teslim edilmeli."""

    def __init__(self, delay: int, cause: BaseException) -> None:
        super().__init__(f"gecici hata ({type(cause).__name__}), {delay} sn sonra yeniden")
        self.delay = delay


def retry_delay(delivery_count: int) -> int:
    """Ustel geri cekilme: 15, 30, 60 (ust sinir) sn. `delivery_count` 1'den baslar."""
    return min(RETRY_MAX_SECONDS, RETRY_BASE_SECONDS * 2 ** max(0, delivery_count - 1))


def instance_tokens_per_minute() -> int:
    """Her ornege dusen Jina butcesi: toplam / es zamanlilik tavani.

    `TokenBudget` surec ici oldugundan, `MAX_CONCURRENCY` kadar ornek ayni anda
    calisabilir; bolum toplamin yapilandirilan degeri asmamasini saglar.
    """
    return max(1, tokens_per_minute_from_env() // MAX_CONCURRENCY)


def build_embedder() -> EmbeddingClient | None:
    """Kaynak gorsel istemcisi; anahtar yoksa `None` (metinle arama)."""
    if not env("JINA_API_KEY"):
        logger.warning("JINA_API_KEY yok: link aramasi gorselsiz, yalnizca metinle calisir")
        return None
    return JinaEmbeddingClient(
        budget=TokenBudget(tokens_per_minute=instance_tokens_per_minute()),
        max_attempts=EMBED_ATTEMPTS,
    )


class _Shared:
    """Sicak ornekte yeniden kullanilan istemciler (Fluid Compute ornegi tekrar kullanir)."""

    page_client: httpx.Client | None = None
    image_client: httpx.Client | None = None
    robots: RobotsCache | None = None
    embedder: EmbeddingClient | None = None
    embedder_ready = False


def _shared() -> type[_Shared]:
    if _Shared.page_client is None:
        _Shared.page_client = guarded_client(user_agent=USER_AGENT)
        _Shared.image_client = guarded_client(user_agent=USER_AGENT, follow_redirects=True)
        _Shared.robots = RobotsCache()
    if not _Shared.embedder_ready:
        _Shared.embedder = build_embedder()
        _Shared.embedder_ready = True
    return _Shared


def parse_request_id(payload: object) -> str | None:
    """Mesajdan `request_id`; bicim bozuksa `None` (yalnizca UUID kabul edilir)."""
    if not isinstance(payload, dict):
        return None
    value = payload.get("request_id")
    if isinstance(value, str) and _UUID.match(value):
        return value.lower()
    return None


def handle_message(
    payload: object,
    delivery_count: int,
    *,
    connect: Callable[[], AbstractContextManager[psycopg.Connection]] = connect_pooled,
    clients: Callable[[], type[_Shared]] = _shared,
    max_attempts: int = MAX_ATTEMPTS,
) -> Outcome:
    """Tek mesaji isler. `TransientFailure` firlatirsa mesaj yeniden teslim edilmelidir."""
    request_id = parse_request_id(payload)
    if request_id is None:
        logger.error("kuyruk mesaji gecersiz, atlandi")
        return Outcome.INVALID

    final_attempt = delivery_count >= max_attempts
    try:
        with connect() as conn:
            return _process(conn, request_id, delivery_count, final_attempt, clients)
    except TransientFailure:
        raise
    except Exception as error:
        # Baglanti kurulamadi / beklenmeyen hata, satir isaretlenemedi.
        if final_attempt:
            logger.exception("son teslimat basarisiz, mesaj birakildi: %s", request_id)
            return Outcome.GAVE_UP
        logger.warning("gecici hata, yeniden denenecek: %s (%s)", request_id, type(error).__name__)
        raise TransientFailure(retry_delay(delivery_count), error) from error


def _process(
    conn: psycopg.Connection,
    request_id: str,
    delivery_count: int,
    final_attempt: bool,
    clients: Callable[[], type[_Shared]],
) -> Outcome:
    claimed = claim_request(conn, request_id, reclaim_processing=delivery_count > 1)
    if claimed is None:
        logger.info("sahiplenilemedi (yok/bitmis/baskasinda), atlaniyor: %s", request_id)
        return Outcome.SKIPPED
    url_raw, session_id, user_id = claimed

    shared = clients()
    try:
        with _RESOLVE_LOCK:
            resolve_claimed(
                conn,
                request_id,
                url_raw,
                session_id,
                user_id,
                client=shared.page_client,
                robots=shared.robots,
                embedder=shared.embedder,
                image_http=shared.image_client,
            )
    except Exception as error:
        _rollback_quietly(conn)
        if not final_attempt:
            # Satir `processing` kalir; yeniden teslimat onu sahiplenebilir.
            raise TransientFailure(retry_delay(delivery_count), error) from error
        logger.exception("son teslimat: istek basarisiz isaretleniyor: %s", request_id)
        _mark(conn, request_id, status="failed", error_code="unexpected", finished=True)
        return Outcome.GAVE_UP
    return Outcome.RESOLVED_OR_FAILED


def _rollback_quietly(conn: psycopg.Connection) -> None:
    try:
        conn.rollback()
    except Exception:
        logger.debug("rollback basarisiz (baglanti kopmus olabilir)")
