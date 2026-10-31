"""Otomatik kalite kapisi: draft/held/ready -> ready | held (karar 0121).

Aktarimdan AYRIDIR: urun uretmez, yayinlamaz, offer'a yazmaz. Yalnizca kaynak teklifin
GUNCEL durumuna bakip `publication_state` ve `hold_reason` yazar. Saf SQL, parti parti,
tekrar calistirilabilir (degismeyen satir yazilmaz). Kapidan gecmek yayin karari DEGILDIR;
yayin `publish.py` ve acik onay ister.

Kapi dusurme nedenleri (`hold_reason`):

  source_offer_missing / source_offer_inactive  kaynak teklif yok ya da pasif
  no_price                   fiyat yok ya da <= 0
  no_image / title_missing   urun satirinda gorsel/baslik yok
  stale_source_offer         kaynakta `stale_days` gundur gorulmedi (OFFER_SEEN_AT mantigi)
  offer_linked_elsewhere     teklif zaten baska bir urune bagli

Yurt disi (TRY disi) teklif: yurt disi urun gosterimi acik bir urun karari bekliyor (karar
0113/0114). Bu bir KALITE sorunu degil, bekleyen karardir: urun `draft` KALIR (satir
yazilmaz; 2,5M satirlik ilk kapi kosusunda tum tabloyu yeniden yazmak gereksiz sisme ve
WAL olurdu) ve `foreign_blocked` olarak sayilir. `--allow-foreign` ile kapidan gecer.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field

import psycopg

DEFAULT_BATCH = 5_000
#: Yeni yayin icin tazelik esigi (karar 0160). Besleme gunde iki kez kosar; 2 gun = en az
#: dort kacirilmis senkronizasyon. Yonetim paneli `STALE_OFFER_DAYS` (7) yalnizca bir
#: GOSTERGEDIR (yayin kapisi degil) ve bilerek ayri tutulur. `gate` ve `publish` ayni
#: sabiti kullanir.
PUBLISH_STALE_DAYS = 2
DEFAULT_STALE_DAYS = PUBLISH_STALE_DAYS

#: Parti: `id > after` anahtarli; ayni parti tek ifadede guncellenir. `seen` ilkesi
#: `OFFER_SEEN_AT` ile aynidir: GREATEST(offer.last_seen_at, max(uyelik.last_seen_at)).
GATE_BATCH = """
WITH batch AS (
    SELECT p.id, p.publication_state, p.hold_reason, p.title, p.primary_image_url,
           p.source_offer_id
      FROM product p
     WHERE p.publication_state IN ('draft', 'held', 'ready') AND p.id > %(after)s
     ORDER BY p.id
     LIMIT %(limit)s
), verdict AS (
    SELECT b.id, b.publication_state AS old_state, b.hold_reason AS old_reason,
           o.currency AS currency,
           CASE
             WHEN o.id IS NULL THEN 'source_offer_missing'
             WHEN NOT o.is_active THEN 'source_offer_inactive'
             WHEN o.current_price IS NULL OR o.current_price <= 0 THEN 'no_price'
             WHEN b.title IS NULL OR btrim(b.title) = '' THEN 'title_missing'
             WHEN b.primary_image_url IS NULL OR btrim(b.primary_image_url) = '' THEN 'no_image'
             WHEN o.product_id IS NOT NULL AND o.product_id <> b.id THEN 'offer_linked_elsewhere'
             WHEN seen.at IS NULL
               OR seen.at < now() - (%(stale_days)s * interval '1 day') THEN 'stale_source_offer'
             WHEN o.currency <> 'TRY' AND NOT %(allow_foreign)s THEN 'foreign_blocked'
           END AS reason
      FROM batch b
      LEFT JOIN offer o ON o.id = b.source_offer_id
      LEFT JOIN LATERAL (
          SELECT GREATEST(o.last_seen_at, max(fo.last_seen_at)) AS at
            FROM feed_source_offer fo WHERE fo.offer_id = o.id
      ) seen ON true
), target AS (
    SELECT v.id, v.old_state, v.old_reason,
           CASE WHEN v.reason IS NULL THEN 'ready'
                WHEN v.reason = 'foreign_blocked' THEN 'draft'
                ELSE 'held' END AS new_state,
           CASE WHEN v.reason = 'foreign_blocked' THEN NULL ELSE v.reason END AS new_reason
      FROM verdict v
), changed AS (
    UPDATE product p SET
        publication_state = t.new_state,
        hold_reason = t.new_reason,
        updated_at = now()
      FROM target t
     WHERE p.id = t.id
       AND (t.old_state, t.old_reason) IS DISTINCT FROM (t.new_state, t.new_reason)
    RETURNING p.id
)
SELECT (SELECT max(id) FROM batch) AS last_id,
       (SELECT count(*) FROM batch) AS scanned,
       (SELECT count(*) FROM changed) AS changed,
       (SELECT count(*) FROM verdict WHERE reason IS NULL) AS ready,
       (SELECT count(*) FROM verdict WHERE reason = 'foreign_blocked') AS foreign_blocked,
       COALESCE((SELECT jsonb_object_agg(reason, n) FROM (
           SELECT reason, count(*) AS n FROM verdict
            WHERE reason IS NOT NULL AND reason <> 'foreign_blocked' GROUP BY reason
       ) r), '{}'::jsonb) AS held
"""


@dataclass
class GateCounts:
    scanned: int = 0
    changed: int = 0
    ready: int = 0
    foreign_blocked: int = 0
    held: dict[str, int] = field(default_factory=dict)
    batches: int = 0
    last_product_id: int = 0
    completed: bool = False


def run_gate(
    conn: psycopg.Connection,
    *,
    after_id: int = 0,
    batch_size: int = DEFAULT_BATCH,
    max_batches: int | None = None,
    stale_days: int = DEFAULT_STALE_DAYS,
    allow_foreign: bool = False,
    should_stop: Callable[[], bool] = lambda: False,
    on_batch: Callable[[GateCounts], None] | None = None,
    throttle: Callable[[], bool] | None = None,
) -> GateCounts:
    totals = GateCounts(last_product_id=after_id)
    after = after_id
    while True:
        if should_stop() or (max_batches is not None and totals.batches >= max_batches):
            break
        # WAL geri basinci (karar 0134): False = dur; `--after-id son_urun` ile surer.
        if throttle is not None and not throttle():
            break
        with conn.cursor() as cur:
            cur.execute(
                GATE_BATCH,
                {
                    "after": after,
                    "limit": max(1, batch_size),
                    "stale_days": stale_days,
                    "allow_foreign": allow_foreign,
                },
            )
            row = cur.fetchone()
        conn.commit()
        assert row is not None
        last_id, scanned, changed, ready, foreign_blocked, held = row
        if not scanned:
            totals.completed = True
            break
        totals.batches += 1
        totals.scanned += int(scanned)
        totals.changed += int(changed)
        totals.ready += int(ready)
        totals.foreign_blocked += int(foreign_blocked)
        for reason, n in (held or {}).items():
            totals.held[reason] = totals.held.get(reason, 0) + int(n)
        after = int(last_id)
        totals.last_product_id = after
        if on_batch:
            on_batch(totals)
        if int(scanned) < batch_size:
            totals.completed = True
            break
    return totals
