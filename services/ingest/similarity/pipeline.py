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
from similarity.prices import Observation, PriceStats, compute

logger = logging.getLogger(__name__)

#: Urun basina fiyat gecmisi penceresi. `product_price_stats` alan adlari
#: 90 gunu varsayiyor (min_90d, max_90d, median_90d).
HISTORY_DAYS = 90

#: Urun partisi: okuma (gecmis + guncel fiyat) ve yazim parti basina; bellek
#: yalnizca bir partinin gozlemleriyle sinirli, katalog buyuklugunden bagimsiz.
PRICE_BATCH_SIZE = 1000

#: Gecmisi olabilecek urunler (eslesmis teklifi olan), artan kimlikle sayfalanir.
#: `offer_product_idx` (product_id, kismi) uzerinden sirali tekil tarama.
NEXT_PRODUCTS = """
SELECT DISTINCT product_id FROM offer
 WHERE product_id IS NOT NULL AND product_id > %(after)s
 ORDER BY product_id
 LIMIT %(limit)s
"""

#: Pasif MAGAZANIN gozlemleri dagilima girmez: magaza veri kalitesi ya da
#: para birimi nedeniyle kapatilmis olabilir (0042). Aktif magazanin PASIF
#: teklifinin gecmisi ise gercek bir gecmis fiyattir ve kalir. Yalnizca TRY
#: teklif: `price_point` para birimi tasimaz; yurt disi teklifin cent'i kurus
#: gibi okunup dagilimi kirletmesin (`product.min_price` ile ayni kural, 0113/0124).
PRICE_HISTORY = """
SELECT o.product_id, pp.offer_id, pp.observed_at, pp.price, pp.list_price
  FROM price_point pp
  JOIN offer o ON o.id = pp.offer_id
  JOIN merchant m ON m.id = o.merchant_id AND m.is_active
 WHERE o.product_id = ANY(%(product_ids)s)
   AND o.currency = 'TRY'
   AND pp.observed_at >= now() - make_interval(days => %(days)s)
 ORDER BY o.product_id, pp.offer_id, pp.observed_at
"""

#: Yuzdeligin referans fiyati: kartlardaki `product.min_price` ile AYNI kural
#: (`db/product_aggregates.py`, aramanin `best_offer`'i) — aktif magazanin
#: fiyatli aktif TRY teklifi. Stok durumu, `min_price` gibi, filtrelenmez.
CURRENT_PRICES = """
SELECT o.product_id, min(o.current_price)
  FROM offer o
  JOIN merchant m ON m.id = o.merchant_id AND m.is_active
 WHERE o.product_id = ANY(%(product_ids)s)
   AND o.is_active AND o.current_price IS NOT NULL AND o.currency = 'TRY'
 GROUP BY o.product_id
"""

#: Bu kosuda hesaplanmayan urunun satiri silinir (90 gunluk aktif-magaza
#: gecmisi kalmadi): eski bir yuzdelik "son 90 gunun en dusugu" iddiasini
#: beslemeye devam etmesin. Tablo turetilmis veridir. Kapsam parti araligidir
#: (`lower < product_id <= upper`, son parti ust sinirsiz): ardisik araliklar tum
#: kimlik uzayini kapsar, tek dev `ANY(tum urunler)` dizisi gonderilmez.
DELETE_STALE_STATS = """
DELETE FROM product_price_stats
 WHERE product_id > %(lower)s
   AND (%(upper)s::bigint IS NULL OR product_id <= %(upper)s)
   AND NOT (product_id = ANY(%(computed)s))
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


def refresh_product_aggregates(conn: psycopg.Connection, *, commit: bool = False) -> int:
    """Tam katalog onarimi; olagan yenileme yazma isleminin icinde olur."""
    return product_aggregates.refresh_all_batched(conn, commit=commit)


def _stats_params(product_id: int, stats: PriceStats) -> dict[str, object]:
    return {
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
    }


def refresh_price_stats(
    conn: psycopg.Connection,
    *,
    commit: bool = False,
    batch_size: int = PRICE_BATCH_SIZE,
) -> PriceCounts:
    """Urun partileri halinde: oku, hesapla (`prices.compute`), toplu yaz, araligi temizle.

    `commit=True` her partiyi ayri islemde kaydeder (gece kosusu); varsayilan
    tek islemdir (testler, `--dry-run`). Parti icinde urunler artan kimlikle
    yazilir; es zamanli yazicilarla kilit sirasi tutarli.
    """
    counts = PriceCounts()
    counts.aggregates_updated = refresh_product_aggregates(conn, commit=commit)

    lower = 0
    while True:
        with conn.cursor() as cur:
            cur.execute(NEXT_PRODUCTS, {"after": lower, "limit": batch_size})
            page = [int(row[0]) for row in cur.fetchall()]
        last_page = len(page) < batch_size

        grouped: dict[int, dict[int, list[Observation]]] = {}
        current: dict[int, int] = {}
        if page:
            with conn.cursor() as cur:
                cur.execute(CURRENT_PRICES, {"product_ids": page})
                current = {int(row[0]): int(row[1]) for row in cur.fetchall()}
                cur.execute(PRICE_HISTORY, {"product_ids": page, "days": HISTORY_DAYS})
                # Teklif basina gruplanir: fiyat serisi yalnizca tek bir magazanin
                # listesi icinde anlamlidir (bkz. prices.compute docstring).
                for product_id, offer_id, observed_at, price, list_price in cur:
                    grouped.setdefault(int(product_id), {}).setdefault(int(offer_id), []).append(
                        Observation(
                            observed_at=observed_at,
                            price=int(price),
                            list_price=int(list_price) if list_price is not None else None,
                        )
                    )

        params = []
        for product_id in sorted(grouped):
            stats = compute(grouped[product_id], current.get(product_id))
            params.append(_stats_params(product_id, stats))
            counts.products += 1
            if stats.list_price_inflated:
                counts.inflated += 1

        with conn.cursor() as cur:
            if params:
                # psycopg 3 executemany boru hattiyla gonderir: parti basina ~tek gidis-donus.
                cur.executemany(UPSERT_STATS, params)
            upper = None if last_page else page[-1]
            cur.execute(
                DELETE_STALE_STATS,
                {"lower": lower, "upper": upper, "computed": sorted(grouped)},
            )
            counts.removed += cur.rowcount
        if commit:
            conn.commit()
        if last_page:
            break
        lower = page[-1]

    return counts


def run(
    conn: psycopg.Connection,
    *,
    do_edges: bool = True,
    do_prices: bool = True,
    limit: int | None = None,
    commit: bool = False,
    prune: bool = False,
) -> SimilarityCounts:
    """`commit=True`: her parti ayri islemde (gece kosusu). Varsayilan tek islem."""
    counts = SimilarityCounts()

    if do_edges:
        counts.visual = build_edges(conn, "visual", limit=limit, commit=commit, prune=prune)
        counts.semantic = build_edges(conn, "semantic", limit=limit, commit=commit, prune=prune)

    if do_prices:
        counts.prices = refresh_price_stats(conn, commit=commit)

    return counts
