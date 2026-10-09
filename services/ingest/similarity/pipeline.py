"""Gece toplu isi: benzerlik kenarlari + fiyat istatistikleri.

`architecture.md` §3b ve §4. Ikisi de istek yolunun ONCEDEN hesapladigi
tablolar: istek aninda fiyat gecmisi taranmaz, benzerlik hesaplanmaz.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field

import psycopg

from db import product_aggregates
from similarity.edges import EdgeCounts, build_edges
from similarity.prices import Observation, compute

logger = logging.getLogger(__name__)

#: Urun basina fiyat gecmisi penceresi. `product_price_stats` alan adlari
#: 90 gunu varsayiyor (min_90d, max_90d, median_90d).
HISTORY_DAYS = 90

#: Pasif MAGAZANIN gozlemleri dagilima girmez: magaza veri kalitesi ya da
#: para birimi nedeniyle kapatilmis olabilir (0042). Aktif magazanin PASIF
#: teklifinin gecmisi ise gercek bir gecmis fiyattir ve kalir.
PRICE_HISTORY = """
SELECT o.product_id, pp.offer_id, pp.observed_at, pp.price, pp.list_price
  FROM price_point pp
  JOIN offer o ON o.id = pp.offer_id
  JOIN merchant m ON m.id = o.merchant_id AND m.is_active
 WHERE o.product_id IS NOT NULL
   AND pp.observed_at >= now() - make_interval(days => %(days)s)
 ORDER BY o.product_id, pp.offer_id, pp.observed_at
"""

#: Yuzdeligin referans fiyati: kartlardaki `product.min_price` ile AYNI kural
#: (`db/product_aggregates.py`, aramanin `best_offer`'i) — aktif magazanin
#: fiyatli aktif teklifi. Stok durumu, `min_price` gibi, filtrelenmez.
CURRENT_PRICES = """
SELECT o.product_id, min(o.current_price)
  FROM offer o
  JOIN merchant m ON m.id = o.merchant_id AND m.is_active
 WHERE o.product_id IS NOT NULL AND o.is_active AND o.current_price IS NOT NULL
 GROUP BY o.product_id
"""

#: Bu kosuda hesaplanmayan urunun satiri silinir (90 gunluk aktif-magaza
#: gecmisi kalmadi): eski bir yuzdelik "son 90 gunun en dusugu" iddiasini
#: beslemeye devam etmesin. Tablo turetilmis veridir.
DELETE_STALE_STATS = """
DELETE FROM product_price_stats WHERE NOT (product_id = ANY(%(product_ids)s))
"""

UPSERT_STATS = """
INSERT INTO product_price_stats
    (product_id, min_30d, min_90d, max_90d, median_90d, current_percentile,
     drop_count_90d, last_drop_at, list_price_inflated, list_price_raised_at, computed_at)
VALUES
    (%(product_id)s, %(min_30d)s, %(min_90d)s, %(max_90d)s, %(median_90d)s,
     %(current_percentile)s, %(drop_count_90d)s, %(last_drop_at)s,
     %(list_price_inflated)s, %(list_price_raised_at)s, now())
ON CONFLICT (product_id) DO UPDATE SET
    min_30d              = EXCLUDED.min_30d,
    min_90d              = EXCLUDED.min_90d,
    max_90d              = EXCLUDED.max_90d,
    median_90d           = EXCLUDED.median_90d,
    current_percentile   = EXCLUDED.current_percentile,
    drop_count_90d       = EXCLUDED.drop_count_90d,
    last_drop_at         = EXCLUDED.last_drop_at,
    list_price_inflated  = EXCLUDED.list_price_inflated,
    list_price_raised_at = EXCLUDED.list_price_raised_at,
    computed_at          = EXCLUDED.computed_at
"""


@dataclass
class PriceCounts:
    products: int = 0
    inflated: int = 0
    aggregates_updated: int = 0
    #: Artik hesaplanmayan urunlerin silinen satirlari.
    removed: int = 0


@dataclass
class SimilarityCounts:
    visual: EdgeCounts = field(default_factory=EdgeCounts)
    semantic: EdgeCounts = field(default_factory=EdgeCounts)
    prices: PriceCounts = field(default_factory=PriceCounts)


def refresh_product_aggregates(conn: psycopg.Connection) -> int:
    """Tam katalog onarimi; olagan yenileme yazma isleminin icinde olur."""
    return product_aggregates.refresh_all(conn)


def refresh_price_stats(conn: psycopg.Connection) -> PriceCounts:
    counts = PriceCounts()
    counts.aggregates_updated = refresh_product_aggregates(conn)

    with conn.cursor() as cur:
        cur.execute(CURRENT_PRICES)
        current = {int(row[0]): int(row[1]) for row in cur.fetchall()}

        cur.execute(PRICE_HISTORY, {"days": HISTORY_DAYS})
        rows = cur.fetchall()

    # Teklif basina gruplanir: fiyat serisi yalnizca tek bir magazanin
    # listesi icinde anlamlidir (bkz. prices.compute docstring).
    grouped: dict[int, dict[int, list[Observation]]] = {}
    for product_id, offer_id, observed_at, price, list_price in rows:
        grouped.setdefault(int(product_id), {}).setdefault(int(offer_id), []).append(
            Observation(
                observed_at=observed_at,
                price=int(price),
                list_price=int(list_price) if list_price is not None else None,
            )
        )

    for product_id, by_offer in grouped.items():
        stats = compute(by_offer, current.get(product_id))
        with conn.cursor() as cur:
            cur.execute(
                UPSERT_STATS,
                {
                    "product_id": product_id,
                    "min_30d": stats.min_30d,
                    "min_90d": stats.min_90d,
                    "max_90d": stats.max_90d,
                    "median_90d": stats.median_90d,
                    "current_percentile": stats.current_percentile,
                    "drop_count_90d": stats.drop_count_90d,
                    "last_drop_at": stats.last_drop_at,
                    "list_price_inflated": stats.list_price_inflated,
                    "list_price_raised_at": stats.list_price_raised_at,
                },
            )
        counts.products += 1
        if stats.list_price_inflated:
            counts.inflated += 1

    with conn.cursor() as cur:
        cur.execute(DELETE_STALE_STATS, {"product_ids": sorted(grouped)})
        counts.removed = cur.rowcount

    return counts


def run(
    conn: psycopg.Connection,
    *,
    do_edges: bool = True,
    do_prices: bool = True,
    limit: int | None = None,
) -> SimilarityCounts:
    counts = SimilarityCounts()

    if do_edges:
        counts.visual = build_edges(conn, "visual", limit=limit)
        counts.semantic = build_edges(conn, "semantic", limit=limit)

    if do_prices:
        counts.prices = refresh_price_stats(conn)

    return counts
