"""Yayin: ready -> published (karar 0121). ACIK karar ister; aktarim ve kapi bunu yapmaz.

Yayin aninda, tek islemde parti parti:

1. Kaynak teklif OKUNUR ve politika yeniden uygulanir (kapidan sonra veri degismis olabilir).
2. `offer.product_id` BAGLANIR (yalnizca hala bagsiz, aktif ve izinli para birimindeki
   teklif). Bag kurulamayan urun `held` olur, yayinlanmaz.
3. Urun `published` olur; baslik/gorsel kaynaktan tazelenir (slug SABIT kalir) ve fiyat
   ozeti AYNI UPDATE'te yazilir (TRY-only; yurt disi teklif min_price'i kirletmez). Kural
   `product_aggregate_values` (migration 0090). Urun satiri bir kez yazilir (karar 0135):
   ayri ozet yenilemesi ikinci, HOT olmayan bir surum uretip butun indekslere yeniden
   giriyordu.
4. `match_decision_log` (link, actor=backfill, basis=source_listing) ve `search_outbox`.

TRY disi urunler `CATALOG_PUBLISH_FOREIGN_APPROVED=true` olmadan YAYINLANMAZ: yurt disi
fiyatin herkese acik gosterimi acik bir urun karari (karar 0113/0114).

`unpublish`: bagi koparir (`offer.product_id = NULL`), urunu `ready` yapar. Teklif ve fiyat
verisine dokunmaz.
"""

from __future__ import annotations

import os
from collections.abc import Callable
from dataclasses import dataclass, field

import psycopg
from psycopg.types.json import Jsonb

from catalog_build.policy import POLICIES, SourceOffer, SourcePolicy, evaluate

DEFAULT_BATCH = 500
FOREIGN_APPROVAL_ENV = "CATALOG_PUBLISH_FOREIGN_APPROVED"

SELECT_READY = """
SELECT p.id, o.id, o.external_id, o.url, o.title_raw, o.image_url, o.current_price, o.currency,
       o.is_active, o.product_id, m.slug, p.source_merchant_id
  FROM product p
  JOIN offer o ON o.id = p.source_offer_id
  JOIN merchant m ON m.id = o.merchant_id
 WHERE p.publication_state = 'ready' AND p.id > %(after)s
   AND (%(merchant_id)s::bigint IS NULL OR p.source_merchant_id = %(merchant_id)s)
 ORDER BY p.id
 LIMIT %(limit)s
 FOR UPDATE OF p SKIP LOCKED
"""

LINK_OFFERS = """
UPDATE offer o SET product_id = t.pid
  FROM unnest(%(pids)s::bigint[], %(oids)s::bigint[]) AS t(pid, oid)
 WHERE o.id = t.oid AND o.product_id IS NULL AND o.is_active
RETURNING t.pid
"""

#: Yayin + fiyat ozeti tek yazimda. Ozet, ayni islemde az once baglanan teklifleri okur
#: (`LINK_OFFERS` bu ifadeden once calisir). `cur` guncelleme ONCESI satirdir: ozet
#: degismediyse `price_updated_at` korunur ve satir `aggregates_updated` sayilmaz
#: (`refresh_product_aggregates` ile ayni anlam). Satirlar SELECT_READY'de kilitlendi.
PUBLISH_PRODUCTS = """
UPDATE product p SET publication_state = 'published', hold_reason = NULL,
       published_at = now(), updated_at = now(),
       title = t.title, primary_image_url = t.image,
       min_price = a.min_price, max_price = a.max_price, offer_count = a.offer_count,
       in_stock_count = a.in_stock_count, foreign_offer_count = a.foreign_offer_count,
       price_updated_at = CASE
           WHEN (cur.min_price, cur.max_price, cur.offer_count, cur.in_stock_count,
                 cur.foreign_offer_count)
                IS DISTINCT FROM (a.min_price, a.max_price, a.offer_count, a.in_stock_count,
                                  a.foreign_offer_count)
           THEN now() ELSE cur.price_updated_at END
  FROM unnest(%(pids)s::bigint[], %(titles)s::text[], %(images)s::text[]) AS t(pid, title, image)
  JOIN product_aggregate_values(%(pids)s::bigint[]) AS a ON a.product_id = t.pid
  JOIN product cur ON cur.id = t.pid
 WHERE p.id = t.pid AND p.publication_state = 'ready'
RETURNING (cur.min_price, cur.max_price, cur.offer_count, cur.in_stock_count,
           cur.foreign_offer_count)
          IS DISTINCT FROM (a.min_price, a.max_price, a.offer_count, a.in_stock_count,
                            a.foreign_offer_count)
"""

HOLD_PRODUCTS = """
UPDATE product p SET publication_state = 'held', hold_reason = t.reason, updated_at = now()
  FROM unnest(%(pids)s::bigint[], %(reasons)s::text[]) AS t(pid, reason)
 WHERE p.id = t.pid AND p.publication_state = 'ready'
"""

LOG_LINKS = """
INSERT INTO match_decision_log (offer_id, product_id, decision, actor, basis, evidence)
SELECT t.oid, t.pid, 'link', 'backfill', 'source_listing', %(evidence)s
  FROM unnest(%(pids)s::bigint[], %(oids)s::bigint[]) AS t(pid, oid)
"""

OUTBOX = """
INSERT INTO search_outbox (entity, entity_id, op, reason)
SELECT 'product', pid, 'upsert', %(reason)s FROM unnest(%(pids)s::bigint[]) AS t(pid)
"""

UNPUBLISH = """
WITH picked AS (
    SELECT p.id, p.source_offer_id FROM product p
     WHERE p.id = ANY(%(pids)s) AND p.publication_state = 'published'
       AND p.source_merchant_id IS NOT NULL
     FOR UPDATE
), unlinked AS (
    UPDATE offer o SET product_id = NULL
      FROM picked WHERE o.id = picked.source_offer_id AND o.product_id = picked.id
    RETURNING o.id AS offer_id, picked.id AS pid
), logged AS (
    INSERT INTO match_decision_log
        (offer_id, previous_product_id, decision, actor, basis, evidence)
    SELECT offer_id, pid, 'unlink', 'backfill', 'source_listing_unpublish', '{}'::jsonb
      FROM unlinked
), reverted AS (
    UPDATE product p SET publication_state = 'ready', published_at = NULL, updated_at = now(),
           min_price = NULL, max_price = NULL, offer_count = 0, in_stock_count = 0,
           foreign_offer_count = 0
      FROM picked WHERE p.id = picked.id
    RETURNING p.id
)
SELECT count(*) FROM reverted
"""


@dataclass
class PublishCounts:
    selected: int = 0
    published: int = 0
    held: dict[str, int] = field(default_factory=dict)
    left_ready: dict[str, int] = field(default_factory=dict)
    batches: int = 0
    last_product_id: int = 0
    aggregates_updated: int = 0

    def hold(self, reason: str) -> None:
        self.held[reason] = self.held.get(reason, 0) + 1


def foreign_approved() -> bool:
    return os.environ.get(FOREIGN_APPROVAL_ENV, "").strip().lower() == "true"


def publish_ready(
    conn: psycopg.Connection,
    *,
    limit: int,
    merchant_id: int | None = None,
    batch_size: int = DEFAULT_BATCH,
    allow_foreign: bool = False,
    should_stop: Callable[[], bool] = lambda: False,
    policies: dict[str, SourcePolicy] | None = None,
    throttle: Callable[[], bool] | None = None,
) -> PublishCounts:
    """En fazla `limit` urun yayinlar. `allow_foreign` YETMEZ: ortam onayi da gerekir."""
    foreign_ok = allow_foreign and foreign_approved()
    policies = POLICIES if policies is None else policies
    totals = PublishCounts()
    after = 0
    remaining = max(0, limit)
    while remaining > 0 and not should_stop():
        # WAL geri basinci (karar 0134): parti ACIK ISLEM YOKKEN bekler; False = dur.
        # Kalan urunler `ready` kalir, ayni komut kaldigi yerden surer.
        if throttle is not None and not throttle():
            break
        take = min(batch_size, remaining)
        with conn.cursor() as cur:
            cur.execute(SELECT_READY, {"after": after, "limit": take, "merchant_id": merchant_id})
            rows = cur.fetchall()
        if not rows:
            conn.commit()
            break
        totals.batches += 1
        totals.selected += len(rows)
        after = int(rows[-1][0])
        totals.last_product_id = after

        ok_p: list[int] = []
        ok_o: list[int] = []
        ok_title: list[str] = []
        ok_image: list[str] = []
        hold_p: list[int] = []
        hold_reason: list[str] = []
        for r in rows:
            pid, oid = int(r[0]), int(r[1])
            currency = str(r[7])
            if currency != "TRY" and not foreign_ok:
                # Yayinlanmaz, hold da edilmez: acik onay gelince yayinlanabilir.
                totals.left_ready["foreign_not_approved"] = (
                    totals.left_ready.get("foreign_not_approved", 0) + 1
                )
                continue
            if r[9] is not None and int(r[9]) != pid:
                hold_p.append(pid)
                hold_reason.append("offer_linked_elsewhere")
                totals.hold("offer_linked_elsewhere")
                continue
            offer = SourceOffer(
                offer_id=oid,
                external_id=str(r[2]),
                url=str(r[3]),
                title_raw=str(r[4]),
                image_url=r[5],
                current_price=None if r[6] is None else int(r[6]),
                currency=currency,
                is_active=bool(r[8]),
            )
            verdict = evaluate(offer, policies.get(str(r[10])))
            if verdict.draft is None:
                assert verdict.skip is not None
                hold_p.append(pid)
                hold_reason.append(verdict.skip)
                totals.hold(verdict.skip)
                continue
            ok_p.append(pid)
            ok_o.append(oid)
            ok_title.append(verdict.draft.title)
            ok_image.append(verdict.draft.image_url)

        linked: set[int] = set()
        if ok_p:
            with conn.cursor() as cur:
                cur.execute(LINK_OFFERS, {"pids": ok_p, "oids": ok_o})
                linked = {int(row[0]) for row in cur.fetchall()}
        publish_idx = [i for i, pid in enumerate(ok_p) if pid in linked]
        for pid in ok_p:
            if pid not in linked:
                hold_p.append(pid)
                hold_reason.append("offer_not_linkable")
                totals.hold("offer_not_linkable")

        with conn.cursor() as cur:
            if publish_idx:
                pids = [ok_p[i] for i in publish_idx]
                oids = [ok_o[i] for i in publish_idx]
                cur.execute(
                    PUBLISH_PRODUCTS,
                    {
                        "pids": pids,
                        "titles": [ok_title[i] for i in publish_idx],
                        "images": [ok_image[i] for i in publish_idx],
                    },
                )
                totals.aggregates_updated += sum(1 for (changed,) in cur.fetchall() if changed)
                cur.execute(
                    LOG_LINKS,
                    {
                        "pids": pids,
                        "oids": oids,
                        "evidence": Jsonb({"via": "catalog_build.publish"}),
                    },
                )
                cur.execute(OUTBOX, {"pids": pids, "reason": "source_listing_published"})
                totals.published += len(pids)
            if hold_p:
                cur.execute(HOLD_PRODUCTS, {"pids": hold_p, "reasons": hold_reason})
        conn.commit()
        remaining -= len(rows)
    return totals


def unpublish(conn: psycopg.Connection, product_ids: list[int]) -> int:
    """Yayindan geri alir (bag + durum); teklif/fiyat verisine dokunmaz."""
    if not product_ids:
        return 0
    with conn.cursor() as cur:
        cur.execute(UNPUBLISH, {"pids": [int(p) for p in product_ids]})
        row = cur.fetchone()
    conn.commit()
    return int(row[0]) if row else 0
