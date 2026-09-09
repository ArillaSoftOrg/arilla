"""Kullanici linklerinin fiyat rotasyonu.

`user_discovered` bir merchant'in feed'i yoktur; rotasyon linki YENIDEN
COZUMLEYEREK yurur. Kabul kriterinin ikinci yarisi budur: cozumlenen urun
"o gunden sonra normal fiyat guncelleme rotasyonuna girer"
(`docs/architecture.md`, Katman 2).

Toplu is oldugu icin — tek kullanici istegi degil — her merchant icin bir
`ingest_run` satiri yazilir: sessiz basarisizlik kabul edilmez.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from datetime import UTC, datetime

import httpx
import psycopg

from collect.link import urls
from collect.link.resolver import ResolutionFailed, resolve_url
from collect.link.robots import RobotsCache
from collect.records import RecordRejected

logger = logging.getLogger(__name__)

#: Ayni host'a istekler arasinda en az bu kadar beklenir; robots.txt daha
#: uzun bir sure istiyorsa o kazanir.
DEFAULT_DELAY_SECONDS = 2.0

DUE_OFFERS = """
SELECT o.id, o.url, o.merchant_id, m.domain, m.refresh_minutes
  FROM offer o
  JOIN merchant m ON m.id = o.merchant_id
 WHERE o.discovery_source = 'user_link'
   AND o.is_active
   AND o.last_seen_at < now() - make_interval(mins => m.refresh_minutes)
 ORDER BY o.last_seen_at
 LIMIT %s
"""


@dataclass
class RefreshResult:
    considered: int
    refreshed: int
    failed: int


def _open_run(conn: psycopg.Connection, merchant_id: int, started_at: datetime) -> int:
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO ingest_run (merchant_id, started_at, status)"
            " VALUES (%s, %s, 'running') RETURNING id",
            (merchant_id, started_at),
        )
        row = cur.fetchone()
    assert row is not None
    conn.commit()
    return int(row[0])


def _close_run(
    conn: psycopg.Connection,
    run_id: int,
    status: str,
    seen: int,
    updated: int,
    price_points: int,
    errors: list[str],
) -> None:
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE ingest_run SET
                finished_at = now(), status = %s, offers_seen = %s,
                offers_updated = %s, price_points_written = %s, error_text = %s
             WHERE id = %s
            """,
            (status, seen, updated, price_points, "\n".join(errors[:5]) or None, run_id),
        )
    conn.commit()


def refresh_user_links(
    conn: psycopg.Connection,
    limit: int = 100,
    *,
    client: httpx.Client | None = None,
    robots: RobotsCache | None = None,
    delay: float = DEFAULT_DELAY_SECONDS,
) -> RefreshResult:
    with conn.cursor() as cur:
        cur.execute(DUE_OFFERS, (limit,))
        due = cur.fetchall()

    if not due:
        logger.info("suresi gelmis kullanici linki yok")
        return RefreshResult(considered=0, refreshed=0, failed=0)

    robots_cache = robots or RobotsCache(client=client)
    by_merchant: dict[int, list[tuple[int, str, str]]] = {}
    for offer_id, url, merchant_id, domain, _minutes in due:
        by_merchant.setdefault(int(merchant_id), []).append((int(offer_id), url, domain))

    refreshed = 0
    failed = 0

    for merchant_id, offers in by_merchant.items():
        started_at = datetime.now(UTC)
        run_id = _open_run(conn, merchant_id, started_at)
        errors: list[str] = []
        merchant_refreshed = 0
        last_request = 0.0

        for _offer_id, url, _domain in offers:
            # Nezaket: robots.txt daha uzun bir bekleme istiyorsa ona uyulur.
            origin = urls.normalize(url).origin
            wait = max(delay, robots_cache.crawl_delay(origin) or 0.0)
            elapsed = time.monotonic() - last_request
            if last_request and elapsed < wait:
                time.sleep(wait - elapsed)
            last_request = time.monotonic()

            try:
                resolve_url(conn, url, client=client, robots=robots_cache)
                conn.commit()
                merchant_refreshed += 1
            except (ResolutionFailed, RecordRejected, httpx.HTTPError) as error:
                conn.rollback()
                failed += 1
                errors.append(f"{url}: {error}")
                logger.warning("link yenilenemedi %s: %s", url, error)

        refreshed += merchant_refreshed
        _close_run(
            conn,
            run_id,
            status="success" if not errors else "partial",
            seen=len(offers),
            updated=merchant_refreshed,
            price_points=merchant_refreshed,
            errors=errors,
        )

    return RefreshResult(considered=len(due), refreshed=refreshed, failed=failed)
